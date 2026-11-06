import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./api";
import { mergeLiveTurn, type LiveTurn } from "./chat-store";

function m(id: string, role: "user" | "assistant", content = id): ChatMessage {
  return {
    id,
    conversation_id: "c",
    parent_id: null,
    role,
    content,
    status: "complete",
    model_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    error: null,
    finish_reason: null,
    created_at: "",
  };
}

const persisted = [m("u1", "user"), m("a1", "assistant"), m("u2", "user"), m("a2", "assistant")];

function turn(partial: Partial<LiveTurn>): LiveTurn {
  return {
    conversationId: "c",
    kind: "send",
    user: null,
    assistant: { ...m("live-a", "assistant", "streaming…"), status: "streaming" },
    phase: "streaming",
    historyDropped: 0,
    ...partial,
  };
}

const ids = (list: ChatMessage[]) => list.map((x) => x.id);

describe("mergeLiveTurn", () => {
  it("appends a new exchange", () => {
    const out = mergeLiveTurn(persisted, turn({ user: m("live-u", "user") }));
    expect(ids(out)).toEqual(["u1", "a1", "u2", "a2", "live-u", "live-a"]);
  });

  it("an edit replaces the edited message and everything after it", () => {
    const out = mergeLiveTurn(persisted, turn({ user: m("live-u", "user"), replaceFrom: "u2" }));
    expect(ids(out)).toEqual(["u1", "a1", "live-u", "live-a"]);
  });

  it("a regeneration replaces the old reply", () => {
    const out = mergeLiveTurn(persisted, turn({ kind: "regenerate", replaceFrom: "a2" }));
    expect(ids(out)).toEqual(["u1", "a1", "u2", "live-a"]);
  });

  it("continuing updates the reply in place and keeps its versions", () => {
    const withSiblings = [...persisted.slice(0, 3), { ...persisted[3], sibling_ids: ["x", "a2"] }];
    const out = mergeLiveTurn(
      withSiblings,
      turn({ kind: "continue", assistant: { ...m("a2", "assistant", "a2 and more"), status: "streaming" } }),
    );
    expect(ids(out)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(out[3].content).toBe("a2 and more");
    expect(out[3].sibling_ids).toEqual(["x", "a2"]);
  });

  it("ignores failed turns", () => {
    expect(mergeLiveTurn(persisted, turn({ failed: { message: "x", content: "y" } }))).toBe(persisted);
  });
});
