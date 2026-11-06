import { expect, test, type Page } from "@playwright/test";

const OLLAMA = process.env.CLAWDE_OLLAMA_URL ?? "http://127.0.0.1:11434";

test.beforeAll(async ({ request }) => {
  const ok = await request
    .get(`${OLLAMA}/api/version`, { timeout: 3000 })
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!ok, `Ollama is not running at ${OLLAMA}`);
});

async function ask(page: Page, question: string): Promise<string> {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toHaveAttribute("placeholder", "Message Clawde…", { timeout: 60_000 });
  await page.getByRole("button", { name: "Generation settings" }).click();
  await page.getByLabel("Max output tokens").fill("64");
  await page.keyboard.press("Escape");
  await composer.fill(question);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/chat\/[0-9a-f]{32}$/, { timeout: 30_000 });
  const reply = page.locator("article").last();
  await expect(reply).toHaveAttribute("aria-busy", "false", { timeout: 150_000 });
  return reply.innerText();
}

test("a saved preference is used in a new chat, shown on the reply, and gone once deleted", async ({ page }) => {
  await page.goto("/memory");
  await page.getByRole("button", { name: "New memory" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Memory", { exact: true }).fill("My dog is a beagle named Biscuit.");
  await dialog.getByRole("button", { name: "Save memory" }).click();
  await expect(page.getByRole("list", { name: "Memories" }).getByText("named Biscuit")).toBeVisible();

  const question = "What is my dog's name? Reply with just the name.";
  expect(await ask(page, question)).toContain("Biscuit");
  // The reply says which memory it used.
  await page.getByRole("button", { name: "Used 1 saved memory" }).click();
  await expect(page.getByRole("dialog").getByText("My dog is a beagle named Biscuit.")).toBeVisible();

  await page.goto("/memory");
  await page.getByRole("button", { name: "Delete memory" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete memory" }).click();
  await expect(page.getByText("Nothing saved yet")).toBeVisible();

  expect(await ask(page, question)).not.toContain("Biscuit");
  await expect(page.getByRole("button", { name: /^Used \d+ saved/ })).toHaveCount(0);
});
