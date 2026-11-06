import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders GFM: headings, lists, tables, inline code", () => {
    const { container } = render(
      <Markdown content={"## Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nUse `npm i`."} />,
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container.querySelector("code")?.textContent).toBe("npm i");
  });

  it("highlights fenced code and copies the plain source", async () => {
    // user-event installs its own clipboard; read the copied text back from it.
    const user = userEvent.setup();
    const { container } = render(<Markdown content={"```python\ndef add(a, b):\n    return a + b\n```"} />);
    expect(screen.getByText("python")).toBeInTheDocument();
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("def");
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await navigator.clipboard.readText()).toBe("def add(a, b):\n    return a + b");
  });

  it("does not render raw HTML from model output", () => {
    const { container } = render(
      <Markdown content={'Hi <img src=x onerror="alert(1)"> <script>alert(2)</script> **bold**'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("does not load Markdown images and opens links safely", () => {
    const { container } = render(
      <Markdown content={"![tracker](https://example.com/pixel.png) [docs](https://example.com)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/\[image: tracker/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});
