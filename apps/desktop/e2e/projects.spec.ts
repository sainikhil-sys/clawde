import { expect, test, type Page } from "@playwright/test";

const OLLAMA = process.env.CLAWDE_OLLAMA_URL ?? "http://127.0.0.1:11434";

test.beforeAll(async ({ request }) => {
  const ok = await request
    .get(`${OLLAMA}/api/version`, { timeout: 3000 })
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!ok, `Ollama is not running at ${OLLAMA}`);
});

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f]{32}$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return page.url();
}

async function askInNewProjectChat(page: Page, projectUrl: string, question: string): Promise<string> {
  await page.goto(projectUrl);
  // The project page's own button (the sidebar also has a "New chat" link for chats outside projects).
  await page.getByRole("main").getByRole("link", { name: "New chat" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f]{32}\/new$/);
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

test("project knowledge answers questions and stays inside its project", async ({ page }) => {
  const garden = await createProject(page, "Garden Club");
  await page.getByTestId("knowledge-input").setInputFiles({
    name: "club-facts.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Internal facts for the Garden Club.\n\nThe project codename is MARIGOLD-58.\n"),
  });
  const file = page.getByRole("button", { name: "Preview club-facts.txt" });
  await expect(file).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Project instructions").fill("Answer in one short sentence.");
  await page.getByRole("button", { name: "Save instructions" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  const answer = await askInNewProjectChat(page, garden, "What is the project codename? Reply with the codename.");
  expect(answer).toContain("MARIGOLD-58");
  // The chat header links back to its project.
  await expect(page.locator("header").getByRole("link", { name: "Garden Club" })).toBeVisible();

  // A different project has no access to Garden Club's knowledge.
  const other = await createProject(page, "Chess Club");
  const otherAnswer = await askInNewProjectChat(page, other, "What is the project codename? Reply with the codename.");
  expect(otherAnswer).not.toContain("MARIGOLD-58");

  // Project search finds the knowledge file in Garden Club only.
  await page.goto(garden);
  await page.getByRole("searchbox", { name: "Search this project" }).fill("codename");
  await expect(page.getByRole("list", { name: "Project search results" }).getByText("club-facts.txt")).toBeVisible();
  await page.goto(other);
  await page.getByRole("searchbox", { name: "Search this project" }).fill("MARIGOLD");
  await expect(page.getByText("Nothing in this project matches.")).toBeVisible();
});
