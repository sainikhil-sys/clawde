"""Find artifact blocks in a model reply.

Models are asked (see `prompt.py`) to write artifacts as::

    <artifact identifier="todo-app" type="react" title="Todo app">
    ...complete content...
    </artifact>

Local models are imperfect at this, so parsing is lenient: common MIME-style or file-extension type names
are mapped to our kinds, a Markdown fence wrapped around the content is removed, and missing identifiers are
derived from the title. A missing closing tag is tolerated when the content is a closed code fence;
otherwise an unclosed block (a reply that was cut off) is ignored.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

KINDS = ("html", "react", "svg", "markdown", "mermaid", "chart", "javascript", "code")
#: Kinds rendered in the sandbox (everything except plain code).
RUNNABLE = frozenset(KINDS) - {"code"}

_ALIASES = {
    "html": "html",
    "text/html": "html",
    "htm": "html",
    "react": "react",
    "jsx": "react",
    "tsx": "react",
    "application/vnd.ant.react": "react",
    "svg": "svg",
    "image/svg+xml": "svg",
    "markdown": "markdown",
    "md": "markdown",
    "text/markdown": "markdown",
    "mermaid": "mermaid",
    "application/vnd.ant.mermaid": "mermaid",
    "chart": "chart",
    "chartjs": "chart",
    "chart.js": "chart",
    "javascript": "javascript",
    "js": "javascript",
    "code": "code",
    "application/vnd.ant.code": "code",
}

_OPEN = re.compile(r"<artifact\b([^>]*)>", re.IGNORECASE)
_CLOSE = re.compile(r"</artifact\s*>", re.IGNORECASE)
_LEADING_FENCE = re.compile(r"\s*```[^\n]*\n(.*?)\n\s*```", re.DOTALL)
_ATTR = re.compile(r"""([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
_FENCE = re.compile(r"^\s*```[\w+#.-]*[^\n]*\n(.*?)\n?```\s*$", re.DOTALL)
_SLUG = re.compile(r"[^a-z0-9]+")

MAX_TITLE = 200
MAX_IDENTIFIER = 100


@dataclass(frozen=True, slots=True)
class ArtifactBlock:
    identifier: str
    kind: str
    title: str
    content: str
    language: str | None
    #: Character span of the whole block in the reply.
    start: int
    end: int


def normalise_kind(raw: str | None, language: str | None = None) -> tuple[str, str | None]:
    """Map a type attribute to (kind, language)."""
    value = (raw or "").strip().lower()
    kind = _ALIASES.get(value)
    if kind is None:
        # e.g. type="python": treat as a code snippet in that language.
        return "code", (language or value or None)
    return kind, (language if kind == "code" else None)


def slugify(text: str) -> str:
    slug = _SLUG.sub("-", text.lower()).strip("-")
    return slug[:MAX_IDENTIFIER] or "artifact"


def _strip_fence(content: str) -> str:
    m = _FENCE.match(content)
    return m.group(1) if m else content


_DOCUMENT_END = {
    "html": re.compile(r"</html\s*>", re.IGNORECASE),
    "svg": re.compile(r"</svg\s*>", re.IGNORECASE),
}


def _body_end(text: str, body_start: int, kind: str, finished: bool) -> tuple[str, int] | None:
    """Content and end offset of the block starting at `body_start`, or None if it isn't finished.

    A block normally ends at `</artifact>`. Small models sometimes forget the closing tag:
    - a closed code fence right after the opening tag is taken as the whole block;
    - in a reply that finished normally (`finished`), the block runs to the next opening tag or the end of the
      reply, stopping after the last `</html>` / `</svg>` for those kinds so trailing prose stays out."""
    close = _CLOSE.search(text, body_start)
    next_open = _OPEN.search(text, body_start)
    if close and (next_open is None or close.start() < next_open.start()):
        return text[body_start : close.start()], close.end()
    fence = _LEADING_FENCE.match(text, body_start)
    if fence:
        return fence.group(1), fence.end()
    if not finished:
        return None
    stop = next_open.start() if next_open else len(text)
    doc_end = _DOCUMENT_END.get(kind)
    if doc_end is not None:
        ends = list(doc_end.finditer(text, body_start, stop))
        if ends:
            stop = ends[-1].end()
    return text[body_start:stop], stop


def parse_artifacts(text: str, *, finished: bool = True) -> list[ArtifactBlock]:
    """`finished`: the reply completed normally, so an unclosed block can't still be growing."""
    out: list[ArtifactBlock] = []
    pos = 0
    n = 0
    while (m := _OPEN.search(text, pos)) is not None:
        type_attr = dict((k.lower(), v or v2) for k, v, v2 in _ATTR.findall(m.group(1))).get("type")
        found = _body_end(text, m.end(), normalise_kind(type_attr)[0], finished)
        if found is None:
            pos = m.end()
            continue
        body, end = found
        pos = end
        attrs = {k.lower(): html.unescape(v if v else (v2 or "")) for k, v, v2 in _ATTR.findall(m.group(1))}
        kind, language = normalise_kind(attrs.get("type"), attrs.get("language"))
        content = _strip_fence(body.strip("\n")).strip("\n")
        if not content.strip():
            continue
        n += 1
        title = (attrs.get("title") or "").strip()[:MAX_TITLE] or f"Artifact {n}"
        identifier = slugify(attrs.get("identifier") or attrs.get("id") or title)
        out.append(
            ArtifactBlock(
                identifier=identifier,
                kind=kind,
                title=title,
                content=content,
                language=(language or "")[:40] or None,
                start=m.start(),
                end=end,
            )
        )
    return out
