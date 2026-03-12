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

test("switch to overlays tab", async ({ page }) => {
  const textTab = page.getByRole("button", { name: /Text/i }).first();
  await textTab.click();
  await expect(page.getByText(/text overlays/i)).toBeVisible();
});

test("add text overlay button exists", async ({ page }) => {
  const textTab = page.getByRole("button", { name: /Text/i }).first();
  await textTab.click();
  const addBtn = page.getByRole("button", { name: /Add Text Overlay/i });
  await expect(addBtn).toBeVisible();
});

test("add and remove text overlay", async ({ page }) => {
  const textTab = page.getByRole("button", { name: /Text/i }).first();
  await textTab.click();
  const addBtn = page.getByRole("button", { name: /Add Text Overlay/i });
  await addBtn.click();
  // Should see the default overlay text "Title"
  const overlay = page.locator('input[value="Title"]').first();
  await expect(overlay).toBeVisible();
  // Remove it
  const removeBtn = page.getByRole("button").filter({ has: page.locator('[class*="lucide-x"]') }).first();
  if (await removeBtn.isVisible()) {
    await removeBtn.click();
  }
});
