import { test, expect } from "@playwright/test";
import { importVideos, waitForClipInSidebar } from "../helpers/test-utils";
import { mockOllama } from "../helpers/ollama-mock";

test.beforeEach(async ({ page }) => {
  await mockOllama(page);
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
});

test("merge button appears with multiple clips", async ({ page }) => {
  await importVideos(page, ["test-5s.mp4", "test-3s.mp4"]);
  await waitForClipInSidebar(page, "test-5s.mp4");
  await waitForClipInSidebar(page, "test-3s.mp4");
  const mergeBtn = page.getByRole("button", { name: /Merge/i });
  await expect(mergeBtn).toBeVisible();
});

test("merge button shows clip count", async ({ page }) => {
  await importVideos(page, ["test-5s.mp4", "test-3s.mp4", "test-1s.mp4"]);
  await waitForClipInSidebar(page, "test-5s.mp4");
  await waitForClipInSidebar(page, "test-3s.mp4");
  await waitForClipInSidebar(page, "test-1s.mp4");
  const mergeBtn = page.getByRole("button", { name: /Merge/i });
  await expect(mergeBtn).toContainText("3");
});
