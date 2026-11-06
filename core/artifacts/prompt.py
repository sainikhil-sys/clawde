"""System instructions that tell a model how to create artifacts."""

ARTIFACT_INSTRUCTIONS = """\
You can create artifacts: self-contained content that the user can view, run and edit in a panel next to \
the chat.
Use an artifact for substantial content the user will reuse or change, such as a complete web page, an \
interactive component, a diagram, a chart, a document or a program. Do not use one for short snippets, \
explanations or simple answers.

Write an artifact like this, with the complete content and no Markdown code fences inside:
<artifact identifier="kebab-case-name" type="TYPE" title="Short title">
...content...
</artifact>

TYPE is one of:
- html: a complete HTML page (CSS and JavaScript inline)
- react: a React component; use `export default function App()`, import only from "react", Tailwind \
classes work
- svg: an SVG image
- markdown: a Markdown document
- mermaid: a Mermaid diagram
- chart: a Chart.js configuration as JSON with "type", "data" and optional "options"
- javascript: a JavaScript program; its console output is shown
- code: code in another language; add language="python" (or similar)

To change an artifact, write it again in full with the same identifier. Artifacts run offline in a sandbox: \
they cannot load anything from the internet or make network requests. Before or after an artifact, add a \
sentence or two about it for the user."""
