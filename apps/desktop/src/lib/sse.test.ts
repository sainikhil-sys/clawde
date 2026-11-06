import { describe, expect, it } from "vitest";

import { parseSse } from "./sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const ev of parseSse(streamOf(chunks))) out.push(ev);
  return out;
}

describe("parseSse", () => {
  it("parses named events", async () => {
    expect(await collect(['event: token\ndata: {"text":"a"}\n\nevent: done\ndata: {}\n\n'])).toEqual([
      { event: "token", data: '{"text":"a"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("handles events split across chunks, including inside a field", async () => {
    expect(await collect(["event: tok", 'en\ndata: {"te', 'xt":"hi"}\n', "\n"])).toEqual([
      { event: "token", data: '{"text":"hi"}' },
    ]);
  });

  it("supports CRLF, comments, multi-line data and a final event without trailing blank line", async () => {
    expect(await collect([": keep-alive\r\n\r\ndata: line1\r\ndata: line2\r\n\r\nevent: done\ndata: end"])).toEqual([
      { event: "message", data: "line1\nline2" },
      { event: "done", data: "end" },
    ]);
  });

  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode('data: {"text":"héllo 🌊"}\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    const out = [];
    for await (const ev of parseSse(stream)) out.push(ev);
    expect(JSON.parse(out[0].data).text).toBe("héllo 🌊");
  });
});
