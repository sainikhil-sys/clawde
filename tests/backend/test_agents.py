"""Agents: permissions, approvals, workspace confinement, cancellation, recovery, retries, history."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from api.config import Settings
from api.main import create_app
from core.agents import protocol
from core.permissions import policy
from core.tools import default_registry
from core.tools.base import ToolError
from core.tools.compute import evaluate, query
from services.sandbox.python_runner import RunResult, SandboxStatus
from storage.database.engine import Database
from storage.database.models import AgentRun

from .conftest import BASE_URL, csrf_headers, start_session
from .fakes import FakeProvider, fake_model

PLAN = json.dumps({"plan": ["Do the thing", "Answer"]})


def call(tool: str, **args: Any) -> str:
    return json.dumps({"thought": f"use {tool}", "tool": tool, "args": args})


def final(text: str) -> str:
    return json.dumps({"thought": "done", "final_answer": text})


class FakeSandbox:
    """Stands in for the Python sandbox (the real one is exercised in test_python_sandbox_*)."""

    timeout_s = 30.0

    def __init__(self) -> None:
        self.ran: list[str] = []

    async def status(self, *, refresh: bool = False) -> SandboxStatus:
        return SandboxStatus("not_running", "python:3.12-slim", "test limits", "")

    async def run(self, code: str, *, tier: str) -> RunResult:
        self.ran.append(code)
        return RunResult(tier, "42\n", "", 0, False, 5, False)  # type: ignore[arg-type]


@pytest.fixture
def sandbox(app: FastAPI) -> FakeSandbox:
    fake = FakeSandbox()
    app.state.agents.services["python"] = fake
    return fake


async def start_run(client: httpx.AsyncClient, token: str, **body: Any) -> dict[str, Any]:
    body.setdefault("task", "Do the thing")
    body.setdefault("model_id", "fake:tiny")
    resp = await client.post("/api/agents/runs", json=body, headers=csrf_headers(token))
    assert resp.status_code == 201, resp.text
    data: dict[str, Any] = resp.json()
    return data


async def wait_for(
    client: httpx.AsyncClient, run_id: str, *statuses: str, within: float = 10
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + within
    while True:
        run: dict[str, Any] = (await client.get(f"/api/agents/runs/{run_id}")).json()
        if run["status"] in statuses:
            return run
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"run stayed {run['status']}: {run}")
        await asyncio.sleep(0.02)


async def next_approval(
    client: httpx.AsyncClient, run_id: str, seen: set[str], within: float = 10
) -> dict[str, Any]:
    """Wait for a step (not in `seen`) that is waiting for approval; returns it and remembers it."""
    deadline = asyncio.get_running_loop().time() + within
    while True:
        run = (await client.get(f"/api/agents/runs/{run_id}")).json()
        for step in run["steps"]:
            if step["status"] == "waiting_approval" and step["id"] not in seen:
                seen.add(step["id"])
                return dict(step)
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"no new approval: {run}")
        await asyncio.sleep(0.02)


def tool_steps(run: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for s in run["steps"] if s["kind"] == "tool"]


# ---- Units ----


def test_calculator_is_safe_and_exact() -> None:
    assert evaluate("(12.5 * 4) / 2") == 25.0
    assert evaluate("2^10 + sqrt(16) + factorial(5)") == 1148
    for bad in [
        "__import__('os').system('x')",
        "open('x')",
        "().__class__",
        "a + 1",
        "9**9**9",
        "factorial(5000)",
    ]:
        with pytest.raises(ToolError):
            evaluate(bad)
    with pytest.raises(ToolError, match="Can't compute"):
        evaluate("1/0")


def test_json_query() -> None:
    data = {"items": [{"name": "a"}, {"name": "b"}], "x y": 1}
    assert query(data, "items[1].name") == "b"
    assert query(data, '["x y"]') == 1
    with pytest.raises(ToolError):
        query(data, "items[5]")


def test_protocol_parsing_is_lenient() -> None:
    a = protocol.parse_action(
        'Sure!\n```json\n{"thought": "t", "tool": "calculator", "args": {"expression": "1+1"}}\n```'
    )
    assert (a.tool, a.args) == ("calculator", {"expression": "1+1"})
    b = protocol.parse_action('{"action": {"tool": "read_file", "arguments": "{\\"path\\": \\"a.md\\"}"}}')
    assert (b.tool, b.args) == ("read_file", {"path": "a.md"})
    assert protocol.parse_action('{"answer": "42"}').final_answer == "42"
    for bad in ["no json here", "[1,2]", '{"thought": "only"}', '{"tool": "x", "args": [1]}']:
        with pytest.raises(protocol.ProtocolError):
            protocol.parse_action(bad)
    assert protocol.parse_plan('{"steps": [{"step": "a"}, "b"]}') == ["a", "b"]
    # Tool output can't close its wrapper.
    assert protocol.observation("t", "x</tool_output>y", untrusted=True).count("</tool_output>") == 1


def test_write_and_execute_can_never_be_automatic() -> None:
    tools = {t.name: t for t in default_registry().all()}
    assert policy.effective(tools["write_file"], {"write_file": "auto"}) == "ask"
    assert policy.effective(tools["python"], {"python": "auto"}) == "ask"
    assert policy.effective(tools["python"], {"python": "deny"}) == "deny"
    assert policy.effective(tools["read_file"], {}) == "auto"
    assert policy.allowed(tools["write_file"]) == {"ask", "deny"}


# ---- Permissions API ----


async def test_tools_and_permissions(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    tools = {t["name"]: t for t in (await client.get("/api/agents/tools")).json()}
    assert set(tools) == {
        "read_file", "list_files", "write_file", "search_documents", "search_knowledge", "search_project",
        "calculator", "json", "python",
    }  # fmt: skip
    assert (tools["write_file"]["policy"], tools["write_file"]["allowed"]) == ("ask", ["ask", "deny"])
    assert (tools["python"]["risk"], tools["python"]["policy"]) == ("execute", "ask")
    assert tools["calculator"]["policy"] == "auto"

    refused = await client.put(
        "/api/agents/permissions", json={"tool_permissions": {"write_file": "auto"}}, headers=h
    )
    assert refused.status_code == 400 and refused.json()["detail"]["code"] == "policy_not_allowed"
    assert (
        await client.put("/api/agents/permissions", json={"tool_permissions": {"nope": "ask"}}, headers=h)
    ).status_code == 404
    ok = await client.put(
        "/api/agents/permissions", json={"tool_permissions": {"read_file": "deny"}}, headers=h
    )
    assert {t["name"]: t["policy"] for t in ok.json()}["read_file"] == "deny"
    # Even if write_file were stored as "auto" through the generic settings endpoint, it still asks.
    await client.patch("/api/settings", json={"tool_permissions": {"write_file": "auto"}}, headers=h)
    tools = {t["name"]: t for t in (await client.get("/api/agents/tools")).json()}
    assert tools["write_file"]["policy"] == "ask"
    events = (await client.get("/api/audit")).json()["events"]
    assert any(e["action"] == "agent.permissions" for e in events)


# ---- Runs ----


async def test_run_plans_uses_tools_and_answers(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    provider.script = [PLAN, call("calculator", expression="6*7"), final("It is **42**.")]
    run = await start_run(client, token, task="What is 6 times 7?")
    done = await wait_for(client, run["id"], "completed")
    assert done["plan"] == ["Do the thing", "Answer"] and done["result"] == "It is **42**."
    assert [s["kind"] for s in done["steps"]] == ["plan", "tool", "final"]
    calc = tool_steps(done)[0]
    assert (calc["tool"], calc["status"], calc["approval"], calc["output"]) == (
        "calculator",
        "done",
        "auto",
        "6*7 = 42",
    )
    # The model saw the tools, JSON mode was used, and the result came back as an observation.
    system = provider.received[1][0].content
    assert "- calculator:" in system and "- write_file:" in system and "search_project" not in system
    assert provider.received_params[1].response_format == "json"
    assert "Result of calculator" in provider.received[2][-1].content
    listed = (await client.get("/api/agents/runs")).json()
    assert [r["id"] for r in listed] == [run["id"]]


async def test_denied_tool_never_runs(
    client: httpx.AsyncClient, provider: FakeProvider, settings: Settings
) -> None:
    token = await start_session(client)
    await client.put(
        "/api/agents/permissions",
        json={"tool_permissions": {"write_file": "deny"}},
        headers=csrf_headers(token),
    )
    provider.script = [PLAN, call("write_file", path="x.txt", content="hi"), final("Couldn't write.")]
    run = await start_run(client, token)
    done = await wait_for(client, run["id"], "completed")
    step = tool_steps(done)[0]
    assert (step["status"], step["approval"]) == ("denied", "policy_denied")
    assert not (settings.workspace_dir / "x.txt").exists()
    # It wasn't offered either.
    assert "- write_file:" not in provider.received[1][0].content
    events = (await client.get("/api/audit")).json()["events"]
    assert any(e["action"] == "agent.tool_denied" and e["details"]["reason"] == "policy" for e in events)


async def test_writes_wait_for_approval(
    client: httpx.AsyncClient, provider: FakeProvider, settings: Settings
) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    provider.script = [
        PLAN,
        call("write_file", path="notes/a.txt", content="approved text"),
        call("write_file", path="b.txt", content="should not exist"),
        final("Wrote a.txt."),
    ]
    run = await start_run(client, token)
    seen: set[str] = set()
    step = await next_approval(client, run["id"], seen)
    assert (step["status"], step["risk"], step["args"]["path"]) == (
        "waiting_approval",
        "write",
        "notes/a.txt",
    )
    assert not (settings.workspace_dir / "notes" / "a.txt").exists()  # nothing happens before approval
    ok = await client.post(
        f"/api/agents/runs/{run['id']}/steps/{step['id']}/decision", json={"approve": True}, headers=h
    )
    assert ok.status_code == 200

    second = await next_approval(client, run["id"], seen)
    await client.post(
        f"/api/agents/runs/{run['id']}/steps/{second['id']}/decision",
        json={"approve": False, "note": "not that one"},
        headers=h,
    )
    done = await wait_for(client, run["id"], "completed")
    first, rejected = tool_steps(done)
    assert (first["status"], first["approval"]) == ("done", "approved")
    assert (rejected["status"], rejected["approval"], rejected["error"]) == (
        "denied",
        "denied",
        "not that one",
    )
    assert (settings.workspace_dir / "notes" / "a.txt").read_text(encoding="utf-8") == "approved text"
    assert not (settings.workspace_dir / "b.txt").exists()
    assert "The user denied this action. Their note: not that one" in provider.received[-1][-1].content
    # Deciding again is refused.
    again = await client.post(
        f"/api/agents/runs/{run['id']}/steps/{second['id']}/decision", json={"approve": True}, headers=h
    )
    assert again.status_code == 409
    actions = [e["action"] for e in (await client.get("/api/audit")).json()["events"]]
    assert {"agent.approval", "agent.tool_run", "agent.tool_denied", "agent.start"} <= set(actions)


async def test_writes_outside_the_workspace_are_blocked(
    client: httpx.AsyncClient, provider: FakeProvider, settings: Settings, tmp_path: Path
) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    outside = tmp_path / "outside.txt"
    attempts = ["../outside.txt", str(outside), "..\\..\\outside.txt", "C:/Windows/evil.txt"]
    provider.script = [PLAN, *[call("write_file", path=p, content="x") for p in attempts], final("No luck.")]
    run = await start_run(client, token)
    seen: set[str] = set()
    for _ in attempts:
        pending = await next_approval(client, run["id"], seen)
        await client.post(
            f"/api/agents/runs/{run['id']}/steps/{pending['id']}/decision", json={"approve": True}, headers=h
        )
    done = await wait_for(client, run["id"], "completed")
    for step in tool_steps(done):
        assert step["status"] == "error" and "Path not allowed" in step["error"], step
    assert not outside.exists()
    assert not (settings.data_dir / "outside.txt").exists()


async def test_cancel_while_waiting_for_approval(
    client: httpx.AsyncClient, provider: FakeProvider, sandbox: FakeSandbox
) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    provider.script = [PLAN, call("python", code="print(42)"), final("x")]
    run = await start_run(client, token)
    waiting = await wait_for(client, run["id"], "waiting_approval")
    step = tool_steps(waiting)[0]
    cancelled = await client.post(f"/api/agents/runs/{run['id']}/cancel", headers=h)
    assert cancelled.json()["status"] == "cancelled"
    assert tool_steps(cancelled.json())[0]["status"] == "cancelled"
    late = await client.post(
        f"/api/agents/runs/{run['id']}/steps/{step['id']}/decision", json={"approve": True}, headers=h
    )
    assert late.status_code == 409
    await asyncio.sleep(0.1)
    assert sandbox.ran == []  # the code never ran
    assert (await client.post(f"/api/agents/runs/{run['id']}/cancel", headers=h)).status_code == 409


async def test_cancel_while_the_model_is_replying(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    provider.token_delay = 0.05
    provider.reply = tuple("x" for _ in range(200))
    run = await start_run(client, token)
    await asyncio.sleep(0.2)
    resp = await client.post(f"/api/agents/runs/{run['id']}/cancel", headers=csrf_headers(token))
    assert resp.json()["status"] == "cancelled" and resp.json()["finished_at"]
    assert provider.streams_closed >= 1


async def test_python_needs_approval_and_runs_in_the_sandbox(
    client: httpx.AsyncClient, provider: FakeProvider, sandbox: FakeSandbox
) -> None:
    token = await start_session(client)
    provider.script = [PLAN, call("python", code="print(6*7)"), final("42")]
    run = await start_run(client, token)
    waiting = await wait_for(client, run["id"], "waiting_approval")
    step = tool_steps(waiting)[0]
    assert step["risk"] == "execute" and sandbox.ran == []
    await client.post(
        f"/api/agents/runs/{run['id']}/steps/{step['id']}/decision",
        json={"approve": True},
        headers=csrf_headers(token),
    )
    done = await wait_for(client, run["id"], "completed")
    ran = tool_steps(done)[0]
    assert sandbox.ran == ["print(6*7)"]
    assert (
        ran["output"] == "42"
        and ran["data"]["tier"] == "fallback"
        and ran["data"]["reduced_isolation"] is True
    )


async def test_recovers_from_bad_replies_and_tool_errors(
    client: httpx.AsyncClient, provider: FakeProvider
) -> None:
    token = await start_session(client)
    provider.script = [
        "not a plan",
        "I think I should calculate",  # not JSON
        call("nonexistent"),
        call("calculator", expression="1/0"),
        call("calculator", wrong="x"),
        final("Recovered."),
    ]
    run = await start_run(client, token)
    done = await wait_for(client, run["id"], "completed")
    kinds = [(s["kind"], s["status"]) for s in done["steps"]]
    assert kinds == [
        ("note", "done"),
        ("error", "error"),
        ("tool", "error"),
        ("tool", "error"),
        ("tool", "error"),
        ("final", "done"),
    ]
    assert "no tool called 'nonexistent'" in done["steps"][2]["error"]
    assert "Can't compute" in done["steps"][3]["error"]
    assert "Invalid arguments for calculator" in done["steps"][4]["error"]


async def test_failures_step_limit_and_retry(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    provider.script = [PLAN, "nope", "nope", "nope"]
    run = await start_run(client, token)
    failed = await wait_for(client, run["id"], "failed")
    assert "unusable format" in failed["error"]

    provider.script = [PLAN] + [call("calculator", expression="1+1")] * 3
    looping = await start_run(client, token, max_steps=3)
    stuck = await wait_for(client, looping["id"], "failed")
    assert "Stopped after 3 steps" in stuck["error"]

    provider.script = [PLAN, final("Second time lucky.")]
    retried = await client.post(f"/api/agents/runs/{run['id']}/retry", headers=h)
    assert retried.status_code == 201 and retried.json()["retry_of"] == run["id"]
    assert (await wait_for(client, retried.json()["id"], "completed"))["result"] == "Second time lucky."

    provider.fail_with = __import__(
        "core.inference.provider", fromlist=["ProviderUnavailable"]
    ).ProviderUnavailable("down")
    broken = await start_run(client, token)
    assert "Model error" in (await wait_for(client, broken["id"], "failed", within=15))["error"]

    assert (await client.delete(f"/api/agents/runs/{run['id']}", headers=h)).status_code == 204
    assert (await client.get(f"/api/agents/runs/{run['id']}")).status_code == 404


async def test_project_scope(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    provider.script = [PLAN, call("search_project", query="x"), final("n/a")]
    run = await start_run(client, token)
    done = await wait_for(client, run["id"], "completed")
    assert "no tool called 'search_project'" in tool_steps(done)[0]["error"]

    project = (await client.post("/api/projects", json={"name": "P"}, headers=csrf_headers(token))).json()
    provider.script = [PLAN, call("search_project", query="anything"), final("ok")]
    scoped = await start_run(client, token, project_id=project["id"])
    done = await wait_for(client, scoped["id"], "completed")
    assert tool_steps(done)[0]["status"] == "done" and "- search_project:" in provider.received[-2][0].content
    missing = await client.post(
        "/api/agents/runs",
        json={"task": "x", "model_id": "fake:tiny", "project_id": "0" * 32},
        headers=csrf_headers(token),
    )
    assert missing.status_code == 404


async def test_events_stream_snapshot_and_validation(
    client: httpx.AsyncClient, provider: FakeProvider
) -> None:
    token = await start_session(client)
    provider.script = [PLAN, final("hi")]
    run = await start_run(client, token)
    await wait_for(client, run["id"], "completed")
    body = (await client.get(f"/api/agents/runs/{run['id']}/events")).text
    event, data = body.split("\n", 1)
    assert event == "event: snapshot"
    assert json.loads(data.split("data: ", 1)[1])["status"] == "completed"
    bad = [{"task": ""}, {"task": "x", "max_steps": 99}, {"task": "x", "model_id": "fake:embedder"}]
    for b in bad:
        assert (await client.post("/api/agents/runs", json=b, headers=csrf_headers(token))).status_code in (
            400,
            422,
        )


async def test_interrupted_runs_are_marked_at_startup(settings: Settings) -> None:
    db = Database(settings.resolved_database_url)
    async with db.sessionmaker() as s:
        s.add(AgentRun(id="r" * 32, task="t", model_id="fake:tiny", status="waiting_approval"))
        await s.commit()
    await db.dispose()
    app = create_app(settings, providers=[FakeProvider(models=[fake_model("tiny")])])
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=BASE_URL) as client:
            await start_session(client)
            run = (await client.get(f"/api/agents/runs/{'r' * 32}")).json()
    assert run["status"] == "interrupted" and "stopped" in run["error"]


async def test_workspace_files_and_sandbox_endpoints(client: httpx.AsyncClient, settings: Settings) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    (settings.workspace_dir / "sub").mkdir(parents=True)
    (settings.workspace_dir / "sub" / "r.md").write_text("# hi", encoding="utf-8")
    files = (await client.get("/api/agents/workspace")).json()
    assert [(f["path"], f["size"]) for f in files] == [("sub/r.md", 4)]
    dl = await client.get("/api/agents/workspace/file", params={"path": "sub/r.md"})
    assert dl.text == "# hi" and dl.headers["content-type"] == "application/octet-stream"
    assert (
        await client.get("/api/agents/workspace/file", params={"path": "../clawde.db"})
    ).status_code == 400
    assert (
        await client.delete("/api/agents/workspace/file", params={"path": "sub/r.md"}, headers=h)
    ).status_code == 204
    assert (await client.get("/api/agents/workspace")).json() == []

    status = (await client.get("/api/agents/sandbox")).json()
    assert status["active_tier"] in ("docker", "fallback") and "network_access_enabled" in status
    # Downloading the image is an internet request: refused while network access is off.
    refused = await client.post("/api/agents/sandbox/prepare", headers=h)
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "network_disabled"
