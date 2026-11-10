import { expect, test } from "@playwright/test";

const OLLAMA = process.env.CLAWDE_OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = "ollama:llama3.2:latest";

test.beforeAll(async ({ request }) => {
  const ok = await request
    .get(`${OLLAMA}/api/version`, { timeout: 3000 })
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!ok, `Ollama is not running at ${OLLAMA}`);
});

test("the library shows real model metadata, and Auto routes a chat to the assigned model with a profile", async ({
  page,
}) => {
  await page.goto("/models");
  const installed = page.getByRole("list", { name: "Installed models" });
  const card = installed.getByRole("button", { name: "llama3.2:latest details" });
  await expect(card).toBeVisible({ timeout: 60_000 });
  // Read from the model itself: architecture, licence and a memory estimate.
  await expect(card).toContainText("llama");
  await expect(card).toContainText("LLAMA 3.2 COMMUNITY LICENSE AGREEMENT");
  await expect(card).toContainText(/Memory needed\s*\d/);
  await card.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Show full licence" }).click();
  await expect(dialog).toContainText("Acceptable Use Policy");
  await expect(dialog).not.toContainText(/unrestricted|uncensored/i);
  await page.keyboard.press("Escape");

  // Downloads are blocked while network access is off (the default).
  await page.getByRole("tab", { name: "Add models" }).click();
  await expect(page.getByText(/Downloading needs internet access, which is off/)).toBeVisible();
  await page.getByLabel("Ollama model name").fill("qwen2.5:0.5b");
  await expect(
    page.getByRole("region", { name: "From the Ollama library" }).getByRole("button", { name: "Download" }),
  ).toBeDisabled();

  // Assign general chat to llama3.2 and check the router's explanation.
  await page.getByRole("tab", { name: "Routing" }).click();
  await page.getByLabel("General chat").selectOption(MODEL);
  await page.getByLabel("Message to route").fill("Tell me something about owls.");
  await page.getByRole("button", { name: "Show choice" }).click();
  await expect(page.getByLabel("Routing decision")).toContainText("llama3.2 for a chat message");
  await expect(page.getByLabel("Routing decision")).toContainText("you assigned this model to chat tasks");

  // A behaviour profile.
  await page.getByRole("tab", { name: "Behaviour profiles" }).click();
  await page.getByRole("button", { name: "New profile" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill("Brief");
  await form.getByLabel("Instructions").fill("Answer in one short sentence.");
  await form.getByLabel("Max output tokens").fill("48");
  await form.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("list", { name: "Behaviour profiles" })).toContainText("Brief");

  // A chat on Auto: the reply says which model answered, why, and which profile applied.
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toHaveAttribute("placeholder", "Message Clawde…", { timeout: 60_000 });
  await page.getByRole("combobox", { name: "Model", exact: true }).filter({ visible: true }).selectOption("auto");
  await composer.fill("Tell me something about owls.");
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/chat\/[0-9a-f]{32}$/, { timeout: 30_000 });
  const reply = page.locator("article").last();
  await expect(reply).toHaveAttribute("aria-busy", "false", { timeout: 150_000 });
  await expect(reply).toContainText("Auto: llama3.2");

  await page.getByRole("button", { name: "Generation settings" }).click();
  await page.getByLabel("Behaviour profile for this chat").selectOption({ label: "Brief" });
  await page.keyboard.press("Escape");
  await composer.fill("And one more fact, please.");
  await composer.press("Enter");
  const second = page.locator("article").last();
  await expect(second).toHaveAttribute("aria-busy", "false", { timeout: 150_000 });
  await expect(second).toContainText("Auto: llama3.2 · Brief");
});
