import { test, expect } from "@playwright/test";
import { mockOllama } from "../helpers/ollama-mock";
import { shouldMockOllama } from "../helpers/test-utils";

test.describe("Ollama Status", () => {
  test("shows Ollama connection status indicator", async ({ page }) => {
    await mockOllama(page);
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();
    // Should show "Ollama (local)" when mocked (connected)
    const status = page.getByText(/Ollama/i).first();
    await expect(status).toBeVisible({ timeout: 10_000 });
  });

  test("model dropdown is populated with mocked models", async ({ page }) => {
    await mockOllama(page);
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();
    // Wait for model loading
    const select = page.locator("select").first();
    await expect(select).toBeVisible({ timeout: 10_000 });
    // Should have at least one real option (not "Loading models…")
    await expect(select.locator("option")).not.toHaveCount(0);
    // Check for mocked model name
    await expect(select).toContainText("qwen3-vl:8b-thinking");
  });

  test("shows green dot when Ollama is connected", async ({ page }) => {
    await mockOllama(page);
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();
    // The green dot indicator
    const greenDot = page.locator(".bg-success").first();
    await expect(greenDot).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Ollama (local)")).toBeVisible();
  });
});
