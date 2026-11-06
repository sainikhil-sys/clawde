/** Minimal Server-Sent Events parser for fetch() response bodies (EventSource can't POST or send headers). */

export type SseEvent = { event: string; data: string };

/** Splits a byte stream into SSE events. Handles events split across chunk boundaries and CRLF line endings. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  // `stream: true` keeps multi-byte characters intact when they are split across chunks.
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Normalize on the whole buffer so a CRLF split across two chunks is still recognized.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    const tail = parseBlock(buffer.trim());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseEvent | null {
  if (!block) return null;
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment / keep-alive
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}
