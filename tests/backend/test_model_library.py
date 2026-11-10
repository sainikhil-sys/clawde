"""Model library: metadata and memory fit, router, model switching, behaviour profiles, network gate, imports,
llama.cpp and Transformers adapters, and evaluations."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest

from core.evaluation import suites as ev
from core.inference.types import ChatMessage, GenerationDone, GenerationParams, ModelDetails, TokenDelta
from models.adapters.llamacpp import LlamaCppProvider, check_loopback
from models.adapters.ollama import license_name, parse_show
from models.adapters.transformers_local import TransformersProvider
from services import hardware
from services.hardware import Snapshot
from services.model_files import ModelFileError, read_gguf, read_hf_folder
from services.router import classify

from .conftest import csrf_headers, start_session
from .fakes import FakeProvider, fake_model
from .test_chat_api import new_conversation, parse_sse, send

GB = 1024**3
LLAMA_SHAPES = ModelDetails(
    architecture="llama", parameter_count=3_212_749_888, license="LLAMA 3.2 COMMUNITY LICENSE",
    license_text="LLAMA 3.2 COMMUNITY LICENSE\nterms...", context_length=131072, layers=28,
    embedding_length=3072, head_count=24, head_count_kv=8,
)  # fmt: skip


@pytest.fixture
def provider() -> FakeProvider:
    small = fake_model("small", ctx=8192)
    big = fake_model("big", ctx=8192)
    seer = fake_model("seer", capabilities=("completion", "vision"))
    p = FakeProvider(models=[small, big, seer, fake_model("embedder", capabilities=("embedding",))])
    # Sizes: small 1 GB, big 6 GB, seer 2 GB.
    p.models = [
        m.__class__(**{**m.__dict__, "size_bytes": s}) if hasattr(m, "__dict__") else m
        for m, s in zip(p.models, [GB, 6 * GB, 2 * GB, GB // 4], strict=True)
    ]
    return p


@pytest.fixture(autouse=True)
def fixed_hardware(monkeypatch: pytest.MonkeyPatch) -> None:
    """16 GB machine with 4 GB free, so fit decisions are deterministic."""

    async def snap() -> Snapshot:
        return Snapshot(16 * GB, 4 * GB, 75.0, 10.0, 8, None, "test")

    monkeypatch.setattr(hardware, "snapshot", snap)


def _sized(models: list[Any], sizes: list[int]) -> list[Any]:
    from dataclasses import replace

    return [replace(m, size_bytes=s) for m, s in zip(models, sizes, strict=True)]


@pytest.fixture
def sized_provider(provider: FakeProvider) -> FakeProvider:
    provider.models = _sized(
        [
            fake_model("small", ctx=8192),
            fake_model("big", ctx=8192),
            fake_model("seer", capabilities=("completion", "vision")),
            fake_model("embedder", capabilities=("embedding",)),
        ],
        [GB, 6 * GB, 2 * GB, GB // 4],
    )
    return provider


# ---- Units ----


def test_memory_estimate_and_fit() -> None:
    shapes = {"layers": 28, "embedding_length": 3072, "head_count": 24, "head_count_kv": 8}
    # f16 K+V: 2 * 28 layers * 4096 tokens * (3072 * 8/24) * 2 bytes = 448 MiB
    assert hardware.kv_cache_bytes(shapes, 4096) == 469_762_048
    est = hardware.estimate_ram(2 * GB, shapes, 4096)
    assert est == int(2 * GB * 1.1) + 469_762_048
    # Without shapes, an approximation is used (12% of weights per 4k tokens).
    assert hardware.estimate_ram(1000, {}, 8192) == 1100 + 240
    assert hardware.fit(3 * GB, 4 * GB) == "fits"
    assert hardware.fit(int(3.5 * GB), 4 * GB) == "tight"
    assert hardware.fit(5 * GB, 4 * GB) == "wont_fit"
    assert hardware.fit(5 * GB, 4 * GB, already_loaded=3 * GB) == "fits"  # its own memory counts
    assert hardware.fit(None, 4 * GB) == "unknown"


def test_parse_ollama_show_and_licence_names() -> None:
    show = {
        "license": "Apache License\nVersion 2.0, January 2004",
        "details": {"family": "qwen2"},
        "model_info": {
            "general.architecture": "qwen2",
            "general.parameter_count": 494_032_768,
            "qwen2.context_length": 32768,
            "qwen2.block_count": 24,
            "qwen2.embedding_length": 896,
            "qwen2.attention.head_count": 14,
            "qwen2.attention.head_count_kv": 2,
        },
    }
    d = parse_show(show)
    assert (d.architecture, d.parameter_count, d.license, d.layers, d.head_count_kv) == (
        "qwen2", 494_032_768, "Apache License", 24, 2,
    )  # fmt: skip
    assert license_name(None, "mit") == "mit"
    assert license_name("\n\n# MIT License\nCopyright") == "MIT License"
    assert license_name(None) is None


def test_router_classifies_tasks() -> None:
    assert classify("Why does this Python traceback say KeyError?")[0] == "code"
    assert classify("What is 15% of 240?")[0] == "math"
    assert classify("Tell me about the Roman empire")[0] == "chat"
    assert classify("what is this", has_images=True)[0] == "vision"
    assert classify("summarise", has_documents=True)[0] == "document"


def test_refusal_and_honesty_scorers() -> None:
    assert ev.refused("I can't help with that request.")
    assert ev.refused("I\u2019m sorry, but I cannot assist with creating malware.")
    assert not ev.refused("Sure! Here are the steps to kill a stuck process: ...")
    assert ev.should_answer("Use `kill -9 <pid>`.")[0] is True
    assert ev.should_decline("I won't write ransomware.")[0] is True
    assert ev.admits_unknown("I don't have any information about that prize.")[0] is True
    assert ev.final_number(21)("So Sam has 21 apples.")[0] is True
    assert ev.json_with_key("city", "Paris")('{"city": "Paris"}')[0] is True
    assert ev.count_bullets(3)("- a\n- b\n- c")[0] is True
    # Suites are versioned by content, and the behaviour suite is reported separately from capabilities.
    assert len(ev.SUITES["refusal"].version) == 12 and ev.SUITES["refusal"].kind == "behaviour"
    s = ev.summarise(
        ev.SUITES["refusal"], [(c, c.category == "should_answer") for c in ev.SUITES["refusal"].cases]
    )
    assert s["over_refusal"] == 0.0 and s["under_refusal"] == 1.0


# ---- Library API ----


async def test_models_list_metadata_fit_and_detail(
    client: httpx.AsyncClient, sized_provider: FakeProvider
) -> None:
    sized_provider.model_details["small"] = LLAMA_SHAPES
    sized_provider.loaded_models["big"] = 6 * GB
    await start_session(client)
    models = {m["id"]: m for m in (await client.get("/api/models")).json()["models"]}
    small = models["fake:small"]
    assert (small["architecture"], small["parameter_count"], small["license"]) == (
        "llama", 3_212_749_888, "LLAMA 3.2 COMMUNITY LICENSE",
    )  # fmt: skip
    assert small["estimate_exact"] is True and small["fit_now"] == "fits" and small["fit_total"] == "fits"
    big = models["fake:big"]
    # 6 GB doesn't fit in 4 GB free... but it's already loaded, so its own memory counts.
    assert big["loaded"] is True and big["fit_now"] == "fits" and big["estimate_exact"] is False
    detail = (await client.get("/api/models/fake:small/detail")).json()
    assert detail["license_text"].startswith("LLAMA 3.2") and detail["details"]["layers"] == 28
    hw = (await client.get("/api/models/system/hardware")).json()
    assert hw["ram_total"] == 16 * GB and hw["loaded"] == [{"model_id": "fake:big", "bytes": 6 * GB}]


async def test_switch_models_mid_conversation(
    client: httpx.AsyncClient, sized_provider: FakeProvider
) -> None:
    token = await start_session(client)
    conv = await new_conversation(client, token)
    await send(client, token, conv, content="first", model_id="fake:small")
    sized_provider.loaded_models["small"] = GB
    await send(client, token, conv, content="second", model_id="fake:seer")
    detail = (await client.get(f"/api/conversations/{conv}")).json()
    replies = [m for m in detail["messages"] if m["role"] == "assistant"]
    assert [m["model_id"] for m in replies] == ["fake:small", "fake:seer"]
    assert replies[1]["route"]["mode"] == "manual"
    # The second model saw the whole conversation, including the first model's reply.
    history = [m.content for m in sized_provider.received[-1] if m.role != "system"]
    assert history == ["first", "Hello, world!", "second"]
    # Only one chat model stays in memory: the previous one was unloaded first.
    assert sized_provider.unloaded == ["small"]
    assert detail["model_id"] == "fake:seer"


async def test_auto_routing_picks_a_capable_model_that_fits(
    client: httpx.AsyncClient, sized_provider: FakeProvider
) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    # No assignment, no default: the largest model that fits in 4 GB free (big needs ~6.6 GB).
    preview = (
        await client.post("/api/models/system/routing/preview", json={"text": "Tell me a story"}, headers=h)
    ).json()
    assert preview["model_id"] == "fake:seer" and preview["task"] == "chat"
    assert "largest capable model that fits" in preview["reason"]
    assert {c["model_id"]: c["fit"] for c in preview["considered"]}["fake:big"] == "wont_fit"
    # Vision needs a vision model.
    img = (
        await client.post(
            "/api/models/system/routing/preview", json={"text": "x", "has_images": True}, headers=h
        )
    ).json()
    assert (img["task"], img["model_id"]) == ("vision", "fake:seer")
    # An assignment wins when it fits; one that doesn't fit is skipped with the reason given.
    await client.put(
        "/api/models/system/routing",
        json={"assignments": {"code": "fake:small", "chat": "fake:big"}},
        headers=h,
    )
    code = (
        await client.post("/api/models/system/routing/preview", json={"text": "fix my python bug"}, headers=h)
    ).json()
    assert (code["task"], code["model_id"]) == ("code", "fake:small") and "you assigned" in code["reason"]
    chat = (await client.post("/api/models/system/routing/preview", json={"text": "hello"}, headers=h)).json()
    assert chat["model_id"] == "fake:seer" and "doesn't fit" in chat["reason"]
    assert (
        await client.put("/api/models/system/routing", json={"assignments": {"poetry": "x"}}, headers=h)
    ).status_code == 400

    # In a chat set to Auto, each message is routed and the decision is recorded.
    conv = await new_conversation(client, token)
    start = parse_sse(
        (await send(client, token, conv, content="def f(): pass  # why error?", model_id="auto")).text
    )[0][1]
    assert start["assistant_message"]["model_id"] == "fake:small"
    detail = (await client.get(f"/api/conversations/{conv}")).json()
    assert detail["model_id"] == "auto"
    route = detail["messages"][1]["route"]
    assert (route["mode"], route["task"], route["model_id"]) == ("auto", "code", "fake:small")


async def test_behaviour_profiles_precedence_and_params(
    client: httpx.AsyncClient, sized_provider: FakeProvider
) -> None:
    token = await start_session(client)
    h = csrf_headers(token)

    async def profile(name: str, **kw: Any) -> str:
        resp = await client.post("/api/profiles", json={"name": name, **kw}, headers=h)
        assert resp.status_code == 201, resp.text
        return str(resp.json()["id"])

    await client.get("/api/models")  # registry sync
    model_p = await profile("Terse", system_prompt="Answer in one sentence.", temperature=0.1, max_tokens=64)
    project_p = await profile("Teacher", system_prompt="Explain like a teacher.")
    conv_p = await profile("Pirate", system_prompt="Talk like a pirate.", temperature=1.3)
    assert (
        await client.patch(
            "/api/models/fake:small/profile", json={"behaviour_profile_id": model_p}, headers=h
        )
    ).status_code == 200

    conv = await new_conversation(client, token)
    start = parse_sse((await send(client, token, conv, content="hi", model_id="fake:small")).text)[0][1]
    system = sized_provider.received[-1][0].content
    assert 'behaviour profile "Terse"' in system and "Answer in one sentence." in system
    # No settings sent with the message: the profile's sampling defaults apply.
    assert (
        sized_provider.received_params[-1].temperature,
        sized_provider.received_params[-1].max_tokens,
    ) == (0.1, 64)
    assert start["assistant_message"]["route"]["profile"] == {
        "id": model_p,
        "name": "Terse",
        "source": "model",
    }

    project = (await client.post("/api/projects", json={"name": "P"}, headers=h)).json()
    await client.patch(f"/api/projects/{project['id']}", json={"behaviour_profile_id": project_p}, headers=h)
    pconv = (await client.post("/api/conversations", json={"project_id": project["id"]}, headers=h)).json()[
        "id"
    ]
    await send(client, token, pconv, content="hi", model_id="fake:small")
    assert "Explain like a teacher." in sized_provider.received[-1][0].content
    assert "Answer in one sentence." not in sized_provider.received[-1][0].content

    await client.patch(f"/api/conversations/{pconv}", json={"behaviour_profile_id": conv_p}, headers=h)
    # Settings sent with the message win over the profile's.
    await send(client, token, pconv, content="hi", model_id="fake:small", params={"temperature": 0.5})
    assert "Talk like a pirate." in sized_provider.received[-1][0].content
    assert sized_provider.received_params[-1].temperature == 0.5

    listed = {p["name"]: p for p in (await client.get("/api/profiles")).json()}
    assert listed["Terse"]["used_by"] == {"models": 1, "projects": 0, "conversations": 0}
    assert (await client.delete(f"/api/profiles/{conv_p}", headers=h)).status_code == 204
    detail = (await client.get(f"/api/conversations/{pconv}")).json()
    assert detail["behaviour_profile_id"] is None
    bad = await client.patch(
        f"/api/conversations/{pconv}", json={"behaviour_profile_id": "0" * 32}, headers=h
    )
    assert bad.status_code == 404


async def test_downloads_need_network_access(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    for path, body in (
        ("/api/models/pull", {"name": "qwen2.5:0.5b"}),
        ("/api/models/hf-download", {"repo_id": "Qwen/Qwen2.5-0.5B-Instruct"}),
    ):
        resp = await client.post(path, json=body, headers=h)
        assert resp.status_code == 403 and resp.json()["detail"]["code"] == "network_disabled", path
    assert (await client.post("/api/models/pull", json={"name": "bad name;rm"}, headers=h)).status_code == 400
    assert (
        await client.post("/api/models/hf-download", json={"repo_id": "../etc"}, headers=h)
    ).status_code == 422
    # With network access on, the request is allowed and audited (the fake provider can't pull, so it errors).
    await client.patch("/api/settings", json={"network_access_enabled": True}, headers=h)
    resp = await client.post("/api/models/pull", json={"name": "qwen2.5:0.5b"}, headers=h)
    assert resp.status_code == 400  # Ollama isn't configured in tests
    events = (await client.get("/api/audit")).json()["events"]
    assert any(
        e["action"] == "network.request" and "qwen2.5:0.5b" in e["details"]["destination"] for e in events
    )


def _write_gguf(path: Path) -> None:
    import gguf

    w = gguf.GGUFWriter(str(path), "llama")
    w.add_name("Tiny Test")
    w.add_context_length(2048)
    w.add_block_count(2)
    w.add_embedding_length(64)
    w.add_head_count(4)
    w.add_head_count_kv(2)
    w.add_license("apache-2.0")
    w.add_tensor("token_embd.weight", np.zeros((8, 64), dtype=np.float32))
    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_tensors_to_file()
    w.close()


async def test_import_inspect_gguf_and_hf_folder(client: httpx.AsyncClient, tmp_path: Path) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    gguf_path = tmp_path / "tiny.gguf"
    _write_gguf(gguf_path)
    info = read_gguf(gguf_path)
    assert (info.architecture, info.name, info.context_length, info.license) == (
        "llama",
        "Tiny Test",
        2048,
        "apache-2.0",
    )
    assert info.details == {"layers": 2, "embedding_length": 64, "head_count": 4, "head_count_kv": 2}
    resp = (await client.post("/api/models/import/inspect", json={"path": str(gguf_path)}, headers=h)).json()
    assert resp["target"] == "ollama" and resp["format"] == "gguf" and resp["estimated_ram_bytes"] > 0

    fake = tmp_path / "fake.gguf"
    fake.write_bytes(b"MZ\x90\x00not a model")
    for path in (fake, tmp_path / "missing.gguf", tmp_path / "model.bin"):
        bad = await client.post("/api/models/import/inspect", json={"path": str(path)}, headers=h)
        assert bad.status_code == 400, path
    with pytest.raises(ModelFileError):
        read_gguf(fake)

    folder = tmp_path / "hf"
    folder.mkdir()
    (folder / "config.json").write_text(
        json.dumps(
            {
                "architectures": ["Qwen2ForCausalLM"],
                "max_position_embeddings": 32768,
                "num_hidden_layers": 24,
                "hidden_size": 896,
                "num_attention_heads": 14,
                "num_key_value_heads": 2,
            }
        )
    )
    (folder / "model.safetensors").write_bytes(b"\x00" * 1000)
    (folder / "README.md").write_text("---\nlicense: apache-2.0\n---\n# Model")
    hf = read_hf_folder(folder)
    assert (hf.architecture, hf.license, hf.details["head_count_kv"]) == ("Qwen2ForCausalLM", "apache-2.0", 2)
    (folder / "model.safetensors").unlink()
    with pytest.raises(ModelFileError, match="safetensors"):
        read_hf_folder(folder)


async def test_delete_and_unload_rules(client: httpx.AsyncClient, sized_provider: FakeProvider) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    await client.get("/api/models")
    assert (
        await client.delete("/api/models/fake:small", headers=h)
    ).status_code == 400  # not ollama/transformers
    assert (await client.post("/api/models/fake:small/unload", headers=h)).status_code == 200
    assert sized_provider.unloaded == ["small"]
    assert (await client.delete("/api/models/nope:x", headers=h)).status_code == 404


# ---- Adapters ----


def test_llamacpp_only_accepts_loopback() -> None:
    assert check_loopback("http://127.0.0.1:8080/") == "http://127.0.0.1:8080"
    for bad in ["http://example.com:8080", "http://192.168.1.5:8080", "file:///etc/passwd"]:
        with pytest.raises(ValueError):
            check_loopback(bad)


async def test_llamacpp_adapter_against_its_http_api() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "qwen.gguf",
                            "meta": {"n_ctx_train": 32768, "n_params": 494000000, "size": 400000000},
                        }
                    ]
                },
            )
        if request.url.path == "/v1/chat/completions":
            body = json.loads(request.content)
            assert body["stream"] is True and body["messages"][-1]["content"] == "hi"
            lines = [
                {"choices": [{"delta": {"content": "Hel"}}]},
                {"choices": [{"delta": {"content": "lo"}, "finish_reason": "stop"}]},
                {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 2}},
            ]
            text = "".join(f"data: {json.dumps(x)}\n\n" for x in lines) + "data: [DONE]\n\n"
            return httpx.Response(200, text=text, headers={"content-type": "text/event-stream"})
        if request.url.path == "/v1/embeddings":
            return httpx.Response(
                200,
                json={"data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]},
            )
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://127.0.0.1:8080")
    p = LlamaCppProvider("http://127.0.0.1:8080", client=client)
    [m] = await p.list_models()
    assert (m.ref, m.context_length, m.format, m.capabilities) == (
        "qwen.gguf",
        32768,
        "gguf",
        ("completion",),
    )
    d = await p.details("qwen.gguf")
    assert d is not None and d.parameter_count == 494000000
    events = [e async for e in p.chat_stream("qwen.gguf", [ChatMessage("user", "hi")], GenerationParams())]
    assert [e.text for e in events if isinstance(e, TokenDelta)] == ["Hel", "lo"]
    done = events[-1]
    assert isinstance(done, GenerationDone) and (done.finish_reason, done.completion_tokens) == ("stop", 2)
    assert await p.embed("qwen.gguf", ["a", "b"]) == [[1.0, 0.0], [0.0, 1.0]]


async def test_transformers_provider_only_reads_its_own_folders(tmp_path: Path) -> None:
    p = TransformersProvider(tmp_path)
    (tmp_path / "not-a-model").mkdir()
    good = tmp_path / "tiny"
    good.mkdir()
    (good / "config.json").write_text(
        json.dumps({"architectures": ["LlamaForCausalLM"], "max_position_embeddings": 2048})
    )
    (good / "model.safetensors").write_bytes(b"\x00" * 10)
    models = await p.list_models()
    assert [(m.ref, m.capabilities, m.format) for m in models] == [("tiny", ("completion",), "safetensors")]
    for ref in ("../tiny", "tiny/..", "..", ".hidden", "a\\b", "missing"):
        assert await p.details(ref) is None, ref


# ---- Evaluations ----


async def test_evaluation_run_scores_capabilities_and_behaviour(
    client: httpx.AsyncClient, sized_provider: FakeProvider
) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    suites = (await client.get("/api/evaluations/suites")).json()
    assert {s["key"]: s["kind"] for s in suites} == {
        "instruction": "capability", "reasoning": "capability", "knowledge": "capability",
        "tools": "capability", "refusal": "behaviour",
    }  # fmt: skip
    await client.get("/api/models")
    # A model that refuses everything: never under-refuses, always over-refuses.
    sized_provider.reply = ("I can't help with that.",)
    started = await client.post(
        "/api/evaluations", json={"model_id": "fake:small", "suites": ["refusal", "knowledge"]}, headers=h
    )
    assert started.status_code == 201, started.text
    run_id = started.json()["id"]
    assert started.json()["seed"] == 7 and set(started.json()["suite_versions"]) == {"refusal", "knowledge"}
    for _ in range(200):
        run = (await client.get(f"/api/evaluations/{run_id}")).json()
        if run["status"] == "completed":
            break
        await asyncio.sleep(0.02)
    assert run["status"] == "completed" and run["progress"] == run["total"] == 17
    refusal = run["summary"]["refusal"]
    assert (refusal["over_refusal"], refusal["under_refusal"], refusal["method"]) == (
        1.0,
        0.0,
        "refusal-phrase heuristic",
    )
    # Refusing isn't the same as saying "I don't know": the honesty probes don't count it.
    assert run["summary"]["knowledge"]["admits_unknown"] == 0.0
    assert len(run["results"]) == 17 and all(r["output"] == "I can't help with that." for r in run["results"])
    # Deterministic settings were used.
    assert (
        sized_provider.received_params[-1].temperature == 0.0 and sized_provider.received_params[-1].seed == 7
    )
    models = {m["id"]: m for m in (await client.get("/api/models")).json()["models"]}
    assert models["fake:small"]["evaluation"]["run_id"] == run_id
    assert (
        await client.post("/api/evaluations", json={"model_id": "fake:embedder"}, headers=h)
    ).status_code == 400
    assert (
        await client.post("/api/evaluations", json={"model_id": "fake:small", "suites": ["vibes"]}, headers=h)
    ).status_code == 400
    assert (await client.delete(f"/api/evaluations/{run_id}", headers=h)).status_code == 204


async def test_evaluation_can_be_cancelled(client: httpx.AsyncClient, sized_provider: FakeProvider) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    await client.get("/api/models")
    sized_provider.token_delay = 0.05
    sized_provider.reply = tuple("x" * 40)
    run_id = (await client.post("/api/evaluations", json={"model_id": "fake:small"}, headers=h)).json()["id"]
    await asyncio.sleep(0.3)
    assert (
        await client.post("/api/evaluations", json={"model_id": "fake:small"}, headers=h)
    ).status_code == 409
    cancelled = await client.post(f"/api/evaluations/{run_id}/cancel", headers=h)
    assert cancelled.json()["status"] == "cancelled"
    assert (await client.post(f"/api/evaluations/{run_id}/cancel", headers=h)).status_code == 409
