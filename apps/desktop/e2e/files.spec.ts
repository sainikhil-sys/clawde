import { expect, test } from "@playwright/test";

const OLLAMA = process.env.CLAWDE_OLLAMA_URL ?? "http://127.0.0.1:11434";

test.beforeAll(async ({ request }) => {
  const ok = await request
    .get(`${OLLAMA}/api/version`, { timeout: 3000 })
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!ok, `Ollama is not running at ${OLLAMA}`);
});

test("chat with an attached file: upload, preview, answer from its contents", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toHaveAttribute("placeholder", "Message Clawde…", { timeout: 60_000 });

  // A made-up fact the model cannot know without reading the file.
  const notes = [
    "Project Lighthouse — internal notes",
    "",
    "The access code for the north storeroom is PELICAN-4471.",
    "The weekly sync happens on Thursdays at 10:30.",
  ].join("\n");
  await page.getByTestId("file-input").setInputFiles({
    name: "lighthouse-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(notes),
  });
  const pending = page.getByLabel("Files to send");
  await expect(pending.getByText("lighthouse-notes.txt")).toBeVisible();
  await expect(pending.getByText(/ready/)).toBeVisible({ timeout: 30_000 });

  // Rejected file types are explained, not silently dropped.
  await page.getByTestId("file-input").setInputFiles({
    name: "tool.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("MZ\x90\x00"),
  });
  await expect(pending.getByText(/aren't supported/)).toBeVisible();
  await page.getByRole("button", { name: "Remove tool.exe" }).click();

  await page.getByRole("button", { name: "Generation settings" }).click();
  await page.getByLabel("Max output tokens").fill("64");
  await page.keyboard.press("Escape");

  await composer.fill("What is the access code for the north storeroom? Answer with the code only.");
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/chat\/[0-9a-f]{32}$/, { timeout: 30_000 });

  const reply = page.locator("article").last();
  await expect(reply).toHaveAttribute("aria-busy", "false", { timeout: 150_000 });
  await expect(reply).toContainText("PELICAN-4471");

  // The sent message keeps its attachment, and the preview shows the extracted text.
  const sent = page.getByLabel("Attached files");
  await sent.getByRole("button", { name: "Preview lighthouse-notes.txt" }).click();
  await expect(page.getByRole("dialog").getByText(/north storeroom is PELICAN-4471/)).toBeVisible();
});
