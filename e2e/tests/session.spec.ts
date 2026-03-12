import { test, expect } from "@playwright/test";
import { importVideo, waitForClipInSidebar } from "../helpers/test-utils";
import { mockOllama } from "../helpers/ollama-mock";

test("session restores after page reload", async ({ page }) => {
  await mockOllama(page);
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();

  // Import a video
  await importVideo(page, "test-5s.mp4");
  await waitForClipInSidebar(page, "test-5s.mp4");

  // Wait for IndexedDB save (debounced)
  await page.waitForTimeout(2000);

  // Reload the page
  await page.reload();
  await expect(page.locator("#root")).not.toBeEmpty();

  // Wait for session restore toast or clip to reappear
  // The app shows "Session restored" toast on reload with data
  const restored = page.getByText(/Session restored|test-5s\.mp4/i).first();
  await expect(restored).toBeVisible({ timeout: 10_000 });
});
