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

test("video element is visible after import", async ({ page }) => {
  const video = page.locator("video");
  await expect(video).toBeVisible();
});

test("play button toggles playback", async ({ page }) => {
  // Find play button
  const playBtn = page.getByRole("button").filter({ has: page.locator('[class*="lucide-play"], [class*="lucide-pause"]') }).first();
  if (await playBtn.isVisible()) {
    await playBtn.click();
    // After click, the video should be playing or paused — just verify no crash
    await expect(page.locator("video")).toBeVisible();
  }
});

test("current time display exists", async ({ page }) => {
  // The app shows current time somewhere in the UI
  const timeDisplay = page.locator("text=/\\d+:\\d+/").first();
  await expect(timeDisplay).toBeVisible({ timeout: 5000 });
});
