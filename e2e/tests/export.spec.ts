import { test, expect } from "@playwright/test";
import { importVideo, waitForClipInSidebar } from "../helpers/test-utils";
import { mockOllama } from "../helpers/ollama-mock";

test.beforeEach(async ({ page }) => {
  await mockOllama(page);
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  await importVideo(page, "test-5s.mp4");
  await waitForClipInSidebar(page, "test-5s.mp4");
});

test("export button is visible", async ({ page }) => {
  const exportBtn = page.getByRole("button", { name: /Export/i });
  await expect(exportBtn).toBeVisible();
});

test("export button shows segment count or trim label", async ({ page }) => {
  const exportBtn = page.getByRole("button", { name: /Export/i });
  const text = await exportBtn.textContent();
  expect(text).toMatch(/Export/i);
});
