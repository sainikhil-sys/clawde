import { expect, test, type Page } from "@playwright/test";

const OLLAMA = process.env.CLAWDE_OLLAMA_URL ?? "http://127.0.0.1:11434";

test.beforeAll(async ({ request }) => {
  const ok = await request
    .get(`${OLLAMA}/api/version`, { timeout: 3000 })
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!ok, `Ollama is not running at ${OLLAMA}`);
});

/** Waits until the last assistant reply has finished streaming and returns its text. */
async function lastReply(page: Page): Promise<string> {
  const reply = page.locator("article").last();
  await expect(reply).toHaveAttribute("aria-busy", "false", { timeout: 150_000 });
  return (await reply.innerText()).trim();
}

test("chat end to end: send, stream, persist, rename, search, export, delete", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toHaveAttribute("placeholder", "Message Clawde…", { timeout: 60_000 });

  // Keep replies short so the test is quick on CPU-only machines.
  await page.getByRole("button", { name: "Generation settings" }).click();
  await page.getByLabel("Max output tokens").fill("64");
  await page.keyboard.press("Escape");

  await composer.fill("Reply with one short sentence about the ocean.");
  await composer.press("Enter");

  await expect(page).toHaveURL(/\/chat\/[0-9a-f]{32}$/, { timeout: 30_000 });
  const text = await lastReply(page);
  expect(text.length).toBeGreaterThan(5);
  const url = page.url();

  // Survives a reload (persisted by the API).
  await page.reload();
  const conversation = page.getByRole("list", { name: "Conversation" });
  await expect(conversation.getByText("Reply with one short sentence about the ocean.")).toBeVisible();
  await expect(page.locator("article").last()).toHaveAttribute("aria-busy", "false");

  // Rename from the chat header menu.
  await page
    .locator("header")
    .getByRole("button", { name: /^Options for/ })
    .click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const title = page.getByRole("textbox", { name: "Title" });
  await title.fill("E2E ocean chat");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("header h1")).toHaveText("E2E ocean chat");
  await expect(page.getByRole("link", { name: "E2E ocean chat" })).toBeVisible();

  // Export downloads a Markdown file containing the conversation.
  await page
    .locator("header")
    .getByRole("button", { name: /^Options for/ })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^e2e-ocean-chat-\d{8}\.md$/);

  // Search finds it by message text on the All chats page.
  await page.goto("/chats");
  await page.getByRole("searchbox", { name: "Search conversations" }).fill("ocean");
  await expect(page.getByRole("list", { name: "Search results" }).getByText("E2E ocean chat")).toBeVisible();

  // Delete with confirmation.
  await page.goto(url);
  await page
    .locator("header")
    .getByRole("button", { name: /^Options for/ })
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(url);
  await expect(page.getByText("Conversation not found")).toBeVisible();
});

test("stop keeps the partial reply and it can be continued", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toHaveAttribute("placeholder", "Message Clawde…", { timeout: 60_000 });
  await composer.fill("Write a long story about a lighthouse.");
  await composer.press("Enter");

  const reply = page.locator("article").last();
  // Wait for some text, then stop.
  await expect(reply.locator(".prose-clawde")).toContainText(/\w{3,}/, { timeout: 120_000 });
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(reply).toContainText("Stopped", { timeout: 15_000 });
  const partial = (await reply.locator(".prose-clawde").innerText()).trim();
  expect(partial.length).toBeGreaterThan(0);

  // Continue appends to the same reply.
  await reply.getByRole("button", { name: /Continue/ }).click();
  // Wait until the continuation has added text before stopping again.
  await expect
    .poll(async () => (await reply.locator(".prose-clawde").innerText()).trim().length, { timeout: 120_000 })
    .toBeGreaterThan(partial.length + 10);
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(reply).toContainText("Stopped", { timeout: 15_000 });
  const continued = (await reply.locator(".prose-clawde").innerText()).trim();
  expect(continued.startsWith(partial.slice(0, 20))).toBe(true);
  expect(continued.length).toBeGreaterThan(partial.length);
});
