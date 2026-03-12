import { test, expect } from "@playwright/test";
import { importVideo, waitForClipInSidebar, shouldMockOllama, isOllamaRunning } from "../helpers/test-utils";
import { mockOllama } from "../helpers/ollama-mock";

test.describe("AI Auto Edit", () => {
  test.beforeEach(async ({ page }) => {
    const useMock = shouldMockOllama() || !(await isOllamaRunning());
    if (useMock) await mockOllama(page);
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();
    await importVideo(page, "test-5s.mp4");
    await waitForClipInSidebar(page, "test-5s.mp4");
  });

  test("auto edit button is visible with clip loaded", async ({ page }) => {
    const autoEditBtn = page.getByRole("button", { name: /Auto Edit with AI/i });
    await expect(autoEditBtn).toBeVisible();
    await expect(autoEditBtn).toBeEnabled();
  });

  test("auto edit shows analyzing state on click", async ({ page }) => {
    const autoEditBtn = page.getByRole("button", { name: /Auto Edit with AI/i });
    await autoEditBtn.click();
    // Should show some loading/analyzing indicator
    const analyzing = page.getByText(/Analyzing|CUT|Extracting/i).first();
    await expect(analyzing).toBeVisible({ timeout: 10_000 });
  });

  test("auto edit produces segments on timeline", async ({ page }) => {
    const autoEditBtn = page.getByRole("button", { name: /Auto Edit with AI/i });
    await autoEditBtn.click();
    // Wait for analysis to complete — look for "highlights selected"
    await expect(page.getByText(/highlights selected/i)).toBeVisible({ timeout: 120_000 });
  });
});
