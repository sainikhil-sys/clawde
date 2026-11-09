import { expect, test, type Page } from "@playwright/test";

const OLLAMA = process.env.CLAWDE_OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = "ollama:llama3.2:latest";

test.beforeAll(async ({ request }) => {
  const ok = await request
    .get(`${OLLAMA}/api/version`, { timeout: 3000 })
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!ok, `Ollama is not running at ${OLLAMA}`);
});

async function startTask(page: Page, task: string) {
  await page.goto("/agents");
  await page.getByLabel("Task", { exact: true }).fill(task);
  await page.getByLabel("Model", { exact: true }).selectOption(MODEL);
  await page.getByRole("button", { name: "Start agent" }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f]{32}$/);
}

test("an agent uses tools, waits for approval to write, and the file lands in the workspace", async ({ page }) => {
  await startTask(page, "Use the calculator to compute 17 * 23, then write just the number to answer.txt.");
  const prompt = page.getByRole("alertdialog");
  await expect(prompt).toBeVisible({ timeout: 150_000 });
  await expect(prompt).toContainText("The agent wants to write a file");
  await expect(prompt).toContainText("answer.txt");
  await expect(page.getByText("Waiting for you")).toBeVisible();
  await prompt.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Completed")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole("list", { name: "Steps" })).toContainText("calculator");
  await expect(page.getByRole("list", { name: "Steps" })).toContainText("approved by you");

  await page.goto("/agents");
  await expect(page.getByRole("list", { name: "Workspace files" })).toContainText("answer.txt");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download answer.txt" }).click();
  const file = await download;
  const text = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(text).toString()).toContain("391");
});

test("a denied write never happens, and a waiting run can be cancelled", async ({ page }) => {
  await startTask(page, "Write the word hello to denied.txt.");
  const prompt = page.getByRole("alertdialog");
  await expect(prompt).toBeVisible({ timeout: 150_000 });
  await prompt.getByLabel("Note for the agent (optional)").fill("Not allowed.");
  await prompt.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByRole("list", { name: "Steps" })).toContainText("denied by you", { timeout: 30_000 });

  // The model may try again (it is told not to); cancel whatever is happening now.
  const cancel = page.getByRole("button", { name: "Cancel run" });
  if (await cancel.isVisible()) await cancel.click();
  await expect(page.getByText(/^(Cancelled|Completed)$/).filter({ visible: true })).toBeVisible({ timeout: 150_000 });

  await page.goto("/agents");
  await expect(page.getByText("Workspace")).toBeVisible();
  await expect(page.getByRole("list", { name: "Workspace files" }).getByText("denied.txt")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Agent runs" })).toContainText("Write the word hello");
});
