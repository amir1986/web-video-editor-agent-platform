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

test("switch to audio tab", async ({ page }) => {
  const audioTab = page.getByRole("button", { name: /Audio/i }).first();
  await audioTab.click();
  await expect(page.getByText(/Volume/i)).toBeVisible();
});

test("volume display shows default 100%", async ({ page }) => {
  const audioTab = page.getByRole("button", { name: /Audio/i }).first();
  await audioTab.click();
  await expect(page.getByText("100%")).toBeVisible();
});

test("volume preset buttons exist", async ({ page }) => {
  const audioTab = page.getByRole("button", { name: /Audio/i }).first();
  await audioTab.click();
  // Preset buttons: 0%, 50%, 100%, 150%, 200%
  await expect(page.getByRole("button", { name: "0%" })).toBeVisible();
  await expect(page.getByRole("button", { name: "50%" })).toBeVisible();
  await expect(page.getByRole("button", { name: "200%" })).toBeVisible();
});

test("clicking volume preset changes value", async ({ page }) => {
  const audioTab = page.getByRole("button", { name: /Audio/i }).first();
  await audioTab.click();
  const btn50 = page.getByRole("button", { name: "50%" });
  await btn50.click();
  // The volume display should now show 50%
  const volumeDisplay = page.locator("text=/50%/");
  await expect(volumeDisplay.first()).toBeVisible();
});
