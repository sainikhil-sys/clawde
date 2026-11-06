"use client";

import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { useMemo } from "react";

import type { ArtifactKind } from "@/lib/api";

function languageFor(kind: ArtifactKind, language: string | null) {
  switch (kind) {
    case "html":
    case "svg":
      return html();
    case "react":
      return javascript({ jsx: true, typescript: true });
    case "javascript":
      return javascript();
    case "chart":
      return json();
    case "markdown":
    case "mermaid":
      return markdown();
    case "code":
      switch ((language ?? "").toLowerCase()) {
        case "python":
        case "py":
          return python();
        case "css":
          return css();
        case "json":
          return json();
        case "html":
          return html();
        case "typescript":
        case "ts":
        case "tsx":
          return javascript({ typescript: true, jsx: true });
        case "javascript":
        case "js":
        case "jsx":
          return javascript({ jsx: true });
        default:
          return null;
      }
  }
}

/** Source editor for an artifact (CodeMirror, bundled locally). */
export function CodeEditor({
  value,
  onChange,
  kind,
  language,
  theme,
  readOnly,
}: {
  value: string;
  onChange?: (value: string) => void;
  kind: ArtifactKind;
  language: string | null;
  theme: "light" | "dark";
  readOnly?: boolean;
}) {
  const extensions = useMemo(() => {
    const lang = languageFor(kind, language);
    return [EditorView.lineWrapping, ...(lang ? [lang] : [])];
  }, [kind, language]);
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={theme}
      readOnly={readOnly}
      editable={!readOnly}
      height="100%"
      className="h-full text-[0.85rem]"
      aria-label="Artifact source"
      basicSetup={{ foldGutter: false, highlightActiveLine: !readOnly }}
    />
  );
}
