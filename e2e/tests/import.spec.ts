import { test, expect } from "@playwright/test";
import { importVideo, importVideos, fixturePath, waitForClipInSidebar, waitForToast } from "../helpers/test-utils";
import { mockOllama } from "../helpers/ollama-mock";

test.beforeEach(async ({ page }) => {
  // Mock Ollama so model loading doesn't fail
  await mockOllama(page);
  await page.goto("/");
  // Wait for app to be ready
  await expect(page.locator("#root")).not.toBeEmpty();
});

test("import single video file", async ({ page }) => {
  await importVideo(page, "test-5s.mp4");
  await waitForClipInSidebar(page, "test-5s.mp4");
  await expect(page.locator("video")).toBeVisible();
});

test("import multiple video files", async ({ page }) => {
  await importVideos(page, ["test-5s.mp4", "test-3s.mp4", "test-1s.mp4"]);
  await waitForClipInSidebar(page, "test-5s.mp4");
  await waitForClipInSidebar(page, "test-3s.mp4");
  await waitForClipInSidebar(page, "test-1s.mp4");
});

test("reject non-video files with toast", async ({ page }) => {
  // Use the raw input (not helper) so we can mix video + non-video
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles([fixturePath("test.txt"), fixturePath("test-5s.mp4")]);
  await waitForToast(page, /Skipped 1 non-video/);
  await waitForClipInSidebar(page, "test-5s.mp4");
});

test("video element loads after import", async ({ page }) => {
  await importVideo(page, "test-5s.mp4");
  await waitForClipInSidebar(page, "test-5s.mp4");
  const video = page.locator("video");
  await expect(video).toBeVisible();
  // Video should have a valid src
  await expect(video).toHaveAttribute("src", /blob:/);
});
