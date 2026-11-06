/**
 * Split an assistant reply into text and `<artifact>` blocks for display. The server parses the same blocks
 * (core/artifacts/parse.py) and is the source of truth for what was saved; this only decides what to draw,
 * including a block that is still streaming (no closing tag yet).
 */

import type { ArtifactKind } from "./api";

export type Segment =
  | { type: "text"; text: string }
  | {
      type: "artifact";
      title: string;
      kind: ArtifactKind;
      /** False while the closing tag hasn't arrived (still generating, or the reply was cut off). */
      complete: boolean;
      /** Position among complete, non-empty blocks: matches the order of the message's saved artifact refs. */
      index: number;
    };

const KIND_ALIASES: Record<string, ArtifactKind> = {
  html: "html",
  "text/html": "html",
  htm: "html",
  react: "react",
  jsx: "react",
  tsx: "react",
  "application/vnd.ant.react": "react",
  svg: "svg",
  "image/svg+xml": "svg",
  markdown: "markdown",
  md: "markdown",
  "text/markdown": "markdown",
  mermaid: "mermaid",
  "application/vnd.ant.mermaid": "mermaid",
  chart: "chart",
  chartjs: "chart",
  "chart.js": "chart",
  javascript: "javascript",
  js: "javascript",
};

const OPEN = /<artifact\b([^>]*)>/gi;
const CLOSE = /<\/artifact\s*>/i;
const ATTR = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  return out;
}

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function kindFromType(type: string | undefined): ArtifactKind {
  return KIND_ALIASES[(type ?? "").trim().toLowerCase()] ?? "code";
}

const LEADING_FENCE = /^\s*```[^\n]*\n([\s\S]*?)\n\s*```/;

/**
 * Where a block ends, like the server: at `</artifact>` (if it comes before the next opening tag), or, when the
 * model forgot the closing tag, after a closed code fence right at the start of the block.
 */
function blockEnd(
  content: string,
  bodyStart: number,
  kind: ArtifactKind,
  finished: boolean,
): { body: string; end: number } | null {
  const rest = content.slice(bodyStart);
  const close = CLOSE.exec(rest);
  const nextOpen = rest.search(/<artifact\b/i);
  if (close && (nextOpen === -1 || close.index < nextOpen)) {
    return { body: rest.slice(0, close.index), end: bodyStart + close.index + close[0].length };
  }
  const fence = LEADING_FENCE.exec(rest);
  if (fence) return { body: fence[1], end: bodyStart + fence[0].length };
  if (!finished) return null;
  // A finished reply: the block runs to the next opening tag or the end, but HTML/SVG stop at their end tag.
  let stop = nextOpen === -1 ? rest.length : nextOpen;
  const endTag = kind === "html" ? /<\/html\s*>/gi : kind === "svg" ? /<\/svg\s*>/gi : null;
  if (endTag) {
    const ends = [...rest.slice(0, stop).matchAll(endTag)];
    const last = ends.at(-1);
    if (last?.index !== undefined) stop = last.index + last[0].length;
  }
  return { body: rest.slice(0, stop), end: bodyStart + stop };
}

/** `finished`: the reply completed normally (an unclosed block then can't still be growing). */
export function splitArtifacts(content: string, finished = false): Segment[] {
  const segments: Segment[] = [];
  let pos = 0;
  let index = 0;
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(content); m; m = OPEN.exec(content)) {
    if (m.index > pos) segments.push({ type: "text", text: content.slice(pos, m.index) });
    const a = attrs(m[1]);
    const bodyStart = m.index + m[0].length;
    const end = blockEnd(content, bodyStart, kindFromType(a.type), finished);
    const complete = end !== null;
    const body = complete ? end.body : content.slice(bodyStart);
    const empty = complete && !body.replace(/```[^\n]*\n?/g, "").trim();
    if (!empty) {
      segments.push({
        type: "artifact",
        title: decode(a.title?.trim() || "") || `Artifact ${index + 1}`,
        kind: kindFromType(a.type),
        complete,
        index: complete ? index : -1,
      });
      if (complete) index++;
    }
    pos = complete ? end.end : content.length;
    OPEN.lastIndex = pos;
    if (!complete) break;
  }
  if (pos < content.length) segments.push({ type: "text", text: content.slice(pos) });
  return segments;
}

/** Artifact kind for a fenced code block's language (for "Open as artifact"). */
export function kindForLanguage(language: string | undefined): { kind: ArtifactKind; language: string | null } {
  const lang = (language ?? "").toLowerCase();
  const kind = KIND_ALIASES[lang];
  if (kind) return { kind, language: null };
  if (lang === "json") return { kind: "code", language: "json" };
  return { kind: "code", language: lang || null };
}
