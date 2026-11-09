import { describe, expect, it } from "vitest";

import { kindForLanguage, splitArtifacts } from "./artifact-blocks";
import { parseRuntimeMessage } from "./sandbox";

describe("splitArtifacts", () => {
  it("separates text from complete and streaming artifact blocks", () => {
    const text =
      'Here it is.\n<artifact identifier="a" type="text/html" title="Page &amp; more">\n<h1>x</h1>\n</artifact>\nDone.\n' +
      '<artifact type="mermaid" title="Flow">graph TD; A-->B';
    expect(splitArtifacts(text)).toEqual([
      { type: "text", text: "Here it is.\n" },
      { type: "artifact", title: "Page & more", kind: "html", complete: true, index: 0 },
      { type: "text", text: "\nDone.\n" },
      { type: "artifact", title: "Flow", kind: "mermaid", complete: false, index: -1 },
    ]);
  });

  it("numbers complete blocks like the server (empty blocks are skipped)", () => {
    const text = '<artifact type="svg" title="E"></artifact><artifact type="python" title="P">print(1)</artifact>';
    expect(splitArtifacts(text)).toEqual([{ type: "artifact", title: "P", kind: "code", complete: true, index: 0 }]);
  });

  it("accepts a fenced block whose closing tag the model forgot (like the server)", () => {
    const text = '<artifact type="mermaid" title="Tea">\n```mermaid\ngraph LR\n  A-->B\n```\nThat is tea.';
    expect(splitArtifacts(text)).toEqual([
      { type: "artifact", title: "Tea", kind: "mermaid", complete: true, index: 0 },
      { type: "text", text: "\nThat is tea." },
    ]);
    // While the fence is still open it is shown as being written.
    expect(splitArtifacts('<artifact type="html" title="P">\n```html\n<p>')[0]).toMatchObject({ complete: false });
  });

  it("treats an unclosed block in a finished reply like the server does", () => {
    const text = '<artifact type="html" title="Greeting"><html><h1>Hi</h1></html>\nThis page greets you.';
    expect(splitArtifacts(text, true)).toEqual([
      { type: "artifact", title: "Greeting", kind: "html", complete: true, index: 0 },
      { type: "text", text: "\nThis page greets you." },
    ]);
    // Still streaming (or stopped): shown as unfinished.
    expect(splitArtifacts(text, false)[0]).toMatchObject({ complete: false });
  });

  it("leaves ordinary replies alone", () => {
    expect(splitArtifacts("Just **text**.")).toEqual([{ type: "text", text: "Just **text**." }]);
  });

  it("maps code block languages to artifact kinds", () => {
    expect(kindForLanguage("jsx")).toEqual({ kind: "react", language: null });
    expect(kindForLanguage("html")).toEqual({ kind: "html", language: null });
    expect(kindForLanguage("python")).toEqual({ kind: "code", language: "python" });
    expect(kindForLanguage(undefined)).toEqual({ kind: "code", language: null });
    // Unlabelled or mislabelled markup: the content decides.
    expect(kindForLanguage("php-template", "<html> <body><h1>Hi</h1></body> </html>")).toEqual({
      kind: "html",
      language: null,
    });
    expect(kindForLanguage(undefined, '<svg viewBox="0 0 1 1"></svg>')).toEqual({ kind: "svg", language: null });
    expect(kindForLanguage("xml", "<note><to>x</to></note>")).toEqual({ kind: "code", language: "xml" });
    expect(kindForLanguage("bash", '<h1 id="greet">Hello</h1>')).toEqual({ kind: "html", language: null });
    expect(kindForLanguage("python", 'print("<p>")')).toEqual({ kind: "code", language: "python" });
  });
});

describe("parseRuntimeMessage", () => {
  it("accepts only the runtime's message shapes", () => {
    expect(parseRuntimeMessage({ type: "clawde-artifact:ready" })).toEqual({ type: "ready" });
    expect(parseRuntimeMessage({ type: "clawde-artifact:error", message: "x".repeat(5000) })).toEqual({
      type: "error",
      message: "x".repeat(2000),
    });
    expect(parseRuntimeMessage({ type: "clawde-artifact:blocked", what: 42 })).toEqual({ type: "blocked", what: "" });
    for (const bad of [null, "ready", { type: "ready" }, { type: "clawde-artifact:navigate", url: "x" }, { type: 1 }]) {
      expect(parseRuntimeMessage(bad)).toBeNull();
    }
  });
});
