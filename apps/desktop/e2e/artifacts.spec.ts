import { expect, test, type Page } from "@playwright/test";

const OLLAMA = process.env.CLAWDE_OLLAMA_URL ?? "http://127.0.0.1:11434";
const API = "http://127.0.0.1:8100";

/** Replaces the source in the Code tab and saves it as a new version. */
async function replaceSource(page: Page, source: string) {
  await page.getByRole("tab", { name: "Code" }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(source);
  await page.getByRole("button", { name: /^Save as version/ }).click();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await page.getByRole("tab", { name: "Preview" }).click();
}

async function newArtifact(page: Page, title: string, type: string) {
  await page.goto("/artifacts");
  await page.getByRole("button", { name: "New artifact" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Type").selectOption(type);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/artifacts\/[0-9a-f]{32}$/);
}

const PROBE = `<!doctype html><html><body><pre id="out">running</pre><script>
const r = {};
const attempt = (name, fn) => { try { r[name] = "allowed:" + String(fn()); } catch (e) { r[name] = "blocked:" + e.name; } };
attempt("cookie", () => document.cookie);
attempt("parentDom", () => parent.document.title);
attempt("topUrl", () => top.location.href);
attempt("storage", () => { localStorage.setItem("x", "1"); return "ok"; });
attempt("indexedDB", () => indexedDB.open("x") && "ok");
r.origin = String(self.origin);
const done = () => { document.getElementById("out").textContent = JSON.stringify(r); };
fetch("${API}/api/conversations", { credentials: "include" })
  .then((x) => { r.fetch = "allowed:" + x.status; }, (e) => { r.fetch = "blocked:" + e.name; })
  .then(() => new Promise((res) => { const ws = (() => { try { return new WebSocket("ws://127.0.0.1:8100/"); } catch (e) { r.ws = "blocked:" + e.name; return null; } })(); if (!ws) return res(); ws.onopen = () => { r.ws = "allowed"; res(); }; ws.onerror = () => { r.ws = "blocked:error"; res(); }; }))
  .then(done, done);
</script></body></html>`;

test("an artifact cannot read the app's cookies or DOM, reach the API, or navigate the app", async ({ page }) => {
  await newArtifact(page, "Sandbox probe", "html");
  // A session cookie exists for the API origin's host; the artifact must not see or use it.
  const cookies = await page.context().cookies(API);
  expect(cookies.some((c) => c.httpOnly)).toBe(true);

  await replaceSource(page, PROBE);
  const out = page.frameLocator('[data-testid="artifact-frame"]').locator("#out");
  await expect(out).not.toHaveText("running", { timeout: 20_000 });
  const r = JSON.parse(await out.innerText());
  expect(r.origin).toBe("null"); // opaque origin
  expect(r.cookie).toMatch(/^blocked:|^allowed:$/); // either throws or is empty: never the session
  expect(r.parentDom).toBe("blocked:SecurityError");
  expect(r.topUrl).toBe("blocked:SecurityError");
  expect(r.storage).toMatch(/^blocked:/);
  expect(r.indexedDB).toMatch(/^blocked:/);
  expect(r.fetch).toBe("blocked:TypeError"); // CSP connect-src 'none'
  expect(r.ws).toMatch(/^blocked:/);
  // The blocked network attempt is reported to the user.
  await expect(page.getByText(/Blocked by the sandbox/)).toBeVisible();

  // Navigation of the app is impossible (no allow-top-navigation).
  await replaceSource(
    page,
    `<script>try { top.location.href = "${API}/api/session"; } catch (e) {}</script><p id="t">tried</p>`,
  );
  await expect(page.frameLocator('[data-testid="artifact-frame"]').locator("#t")).toHaveText("tried");
  await expect(page).toHaveURL(/\/artifacts\/[0-9a-f]{32}$/);
});

test("React, Mermaid, chart and Markdown artifacts render offline, with history and diff", async ({ page }) => {
  await newArtifact(page, "Counter", "react");
  const frame = page.frameLocator('[data-testid="artifact-frame"]');
  const button = frame.getByRole("button", { name: /Clicked 0 times/ });
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  await expect(frame.getByRole("button", { name: "Clicked 1 times" })).toBeVisible();

  await replaceSource(page, 'export default function App() { return <h1 className="text-3xl font-bold">Edited</h1>; }');
  await expect(frame.getByRole("heading", { name: "Edited" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "History" }).click();
  await page.getByRole("button", { name: "Changes" }).click();
  await expect(page.getByLabel("Changes")).toContainText("Edited");
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("version 3 of 3")).toBeVisible();
  await expect(frame.getByRole("button", { name: /Clicked 0 times/ })).toBeVisible({ timeout: 30_000 });

  await newArtifact(page, "Flow", "mermaid");
  await expect(page.frameLocator('[data-testid="artifact-frame"]').locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(page.frameLocator('[data-testid="artifact-frame"]').getByText("Finish")).toBeVisible();

  await newArtifact(page, "Bars", "chart");
  await expect(page.frameLocator('[data-testid="artifact-frame"]').locator("canvas")).toBeVisible({ timeout: 30_000 });

  await newArtifact(page, "Notes", "markdown");
  await replaceSource(page, '# Heading\n\n<img src=x onerror="document.body.dataset.pwned=1">\n\n- item');
  const md = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(md.getByRole("heading", { name: "Heading" })).toBeVisible({ timeout: 30_000 });
  // Markdown is sanitised: the inline handler never runs.
  await expect(md.locator("body[data-pwned]")).toHaveCount(0);
});

test.describe("with a local model", () => {
  test.beforeAll(async ({ request }) => {
    const ok = await request
      .get(`${OLLAMA}/api/version`, { timeout: 3000 })
      .then((r) => r.ok())
      .catch(() => false);
    test.skip(!ok, `Ollama is not running at ${OLLAMA}`);
  });

  test("an artifact written by the model opens in the side panel by itself", async ({ page }) => {
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toHaveAttribute("placeholder", "Message Clawde…", { timeout: 60_000 });
    await composer.fill('Create an HTML page artifact with a single heading that says "Hello Clawde".');
    await composer.press("Enter");
    const reply = page.locator("article").last();
    await expect(reply).toHaveAttribute("aria-busy", "false", { timeout: 150_000 });
    await expect(reply.getByRole("button", { name: /^Open artifact / })).toBeVisible();
    const panel = page.getByRole("complementary", { name: "Artifact panel" });
    await expect(panel.frameLocator('[data-testid="artifact-frame"]').getByText("Hello Clawde")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a code block from a reply opens as an artifact in the side panel", async ({ page }) => {
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toHaveAttribute("placeholder", "Message Clawde…", { timeout: 60_000 });
    await composer.fill(
      'Reply with only a Markdown code block in html containing exactly: <h1 id="greet">Hello Clawde</h1>',
    );
    await composer.press("Enter");
    const reply = page.locator("article").last();
    const openButton = reply.getByRole("button", { name: "Open as artifact" }).first();
    // This checks the app, not the model: if the model ignores the instruction and sends no code block,
    // regenerate (up to 3 tries) until there is one.
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(reply).toHaveAttribute("aria-busy", "false", { timeout: 150_000 });
      if (await openButton.isVisible()) break;
      await reply.getByRole("button", { name: "Regenerate reply" }).click();
      await expect(reply).toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
    }
    await openButton.click();
    const panel = page.getByRole("complementary", { name: "Artifact panel" });
    await expect(panel).toBeVisible();
    // An unlabelled or labelled HTML block opens as a previewable HTML artifact, not plain code.
    await expect(panel.getByRole("region")).toContainText("HTML · version 1");
    await expect(panel.frameLocator('[data-testid="artifact-frame"]').locator("h1")).toBeAttached({
      timeout: 30_000,
    });
  });
});
