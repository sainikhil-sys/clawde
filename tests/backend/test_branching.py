"""Message tree: editing, regenerating, retrying, continuing and switching branches."""

from __future__ import annotations

from typing import Any

import httpx

from core.inference.provider import ProviderError

from .conftest import csrf_headers, start_session
from .fakes import FakeProvider
from .test_chat_api import new_conversation, parse_sse, send


async def detail(client: httpx.AsyncClient, conv_id: str) -> dict[str, Any]:
    data: dict[str, Any] = (await client.get(f"/api/conversations/{conv_id}")).json()
    return data


def contents(d: dict[str, Any]) -> list[tuple[str, str]]:
    return [(m["role"], m["content"]) for m in d["messages"]]


async def post(
    client: httpx.AsyncClient, token: str, conv_id: str, action: str, **body: Any
) -> httpx.Response:
    return await client.post(f"/api/conversations/{conv_id}/{action}", json=body, headers=csrf_headers(token))


async def test_edit_creates_branch_and_keeps_original(
    client: httpx.AsyncClient, provider: FakeProvider
) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="first question")
    await send(client, token, conv_id, content="follow up")
    original = await detail(client, conv_id)
    followup_id = original["messages"][2]["id"]

    provider.reply = ["edited answer"]
    resp = await send(client, token, conv_id, content="follow up, rephrased", edit_of=followup_id)
    assert parse_sse(resp.text)[-1][0] == "done"

    d = await detail(client, conv_id)
    assert contents(d) == [
        ("user", "first question"),
        ("assistant", "Hello, world!"),
        ("user", "follow up, rephrased"),
        ("assistant", "edited answer"),
    ]
    edited = d["messages"][2]
    assert edited["sibling_ids"] == [followup_id, edited["id"]]
    # The model saw history up to the edit point, not the replaced message.
    assert [m.content for m in provider.received[-1] if m.role != "system"] == [
        "first question",
        "Hello, world!",
        "follow up, rephrased",
    ]

    # Switching back restores the original branch, down to its last reply.
    switched = (
        await client.put(
            f"/api/conversations/{conv_id}/branch",
            json={"message_id": followup_id},
            headers=csrf_headers(token),
        )
    ).json()
    assert contents(switched)[2:] == [("user", "follow up"), ("assistant", "Hello, world!")]


async def test_editing_the_first_message(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="v1")
    first_id = (await detail(client, conv_id))["messages"][0]["id"]
    await send(client, token, conv_id, content="v2", edit_of=first_id)
    d = await detail(client, conv_id)
    assert contents(d)[0] == ("user", "v2")
    assert len(d["messages"][0]["sibling_ids"]) == 2
    assert next(m for m in provider.received[-1] if m.role != "system").content == "v2"


async def test_regenerate_adds_alternative_reply(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="tell me a joke")
    old_id = (await detail(client, conv_id))["messages"][1]["id"]

    provider.reply = ["a different joke"]
    events = parse_sse((await post(client, token, conv_id, "regenerate", message_id=old_id)).text)
    assert events[0][0] == "start"
    assert events[0][1]["user_message"] is None
    assert events[-1][0] == "done"

    d = await detail(client, conv_id)
    assert contents(d) == [("user", "tell me a joke"), ("assistant", "a different joke")]
    assert d["messages"][1]["sibling_ids"][0] == old_id
    assert len(d["messages"][1]["sibling_ids"]) == 2
    assert [m.content for m in provider.received[-1] if m.role != "system"] == ["tell me a joke"]


async def test_retry_after_error(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    provider.fail_with = ProviderError("runner crashed")
    await send(client, token, conv_id, content="hi")
    failed = (await detail(client, conv_id))["messages"][1]
    assert failed["status"] == "error"

    provider.fail_with = None
    await post(client, token, conv_id, "regenerate", message_id=failed["id"])
    d = await detail(client, conv_id)
    assert d["messages"][1]["status"] == "complete"
    assert d["messages"][1]["content"] == "Hello, world!"


async def test_continue_appends_to_stopped_reply(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="count")
    # Simulate a reply the user stopped part-way.
    provider.fail_with = ProviderError("boom")
    provider.fail_after_tokens = 2
    await send(client, token, conv_id, content="count more")
    partial = (await detail(client, conv_id))["messages"][3]
    assert (partial["status"], partial["content"]) == ("error", "Hello, ")

    provider.fail_with = None
    provider.fail_after_tokens = None
    provider.reply = ["world", "!"]
    events = parse_sse((await post(client, token, conv_id, "continue", message_id=partial["id"])).text)
    assert events[0][1]["assistant_message"]["content"] == "Hello, "
    assert events[-1][0] == "done"

    d = await detail(client, conv_id)
    assert d["messages"][3]["id"] == partial["id"]
    assert (d["messages"][3]["status"], d["messages"][3]["content"]) == ("complete", "Hello, world!")
    # The partial text was sent as the last (assistant) message for the model to continue.
    sent = provider.received[-1]
    assert (sent[-1].role, sent[-1].content) == ("assistant", "Hello, ")


async def test_continue_rules(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="a")
    d = await detail(client, conv_id)
    user_id, reply_id = d["messages"][0]["id"], d["messages"][1]["id"]
    finished = await post(client, token, conv_id, "continue", message_id=reply_id)
    assert finished.status_code == 400 and finished.json()["detail"]["code"] == "cannot_continue"
    wrong_role = await post(client, token, conv_id, "continue", message_id=user_id)
    assert wrong_role.status_code == 404


async def test_branch_and_actions_validate_ids(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    a = await new_conversation(client, token)
    b = await new_conversation(client, token)
    await send(client, token, a, content="in a")
    msg_in_a = (await detail(client, a))["messages"][0]["id"]
    # Message ids from another conversation are rejected.
    resp = await client.put(
        f"/api/conversations/{b}/branch", json={"message_id": msg_in_a}, headers=csrf_headers(token)
    )
    assert resp.status_code == 404
    resp = await send(client, token, b, content="x", edit_of=msg_in_a)
    assert resp.status_code == 404
