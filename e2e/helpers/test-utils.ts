import { Page, expect } from "@playwright/test";
import path from "path";

const FIXTURES = path.join(__dirname, "..", "fixtures");

export function fixturePath(name: string) {
  return path.join(FIXTURES, name);
}

export async function importVideo(page: Page, filename: string) {
  const fileInput = page.locator('input[type="file"][accept="video/*"]');
  await fileInput.setInputFiles(fixturePath(filename));
}

export async function importVideos(page: Page, filenames: string[]) {
  const fileInput = page.locator('input[type="file"][accept="video/*"]');
  await fileInput.setInputFiles(filenames.map((f) => fixturePath(f)));
}

export async function waitForToast(page: Page, text: string | RegExp) {
  const toast = page.locator(".fixed.bottom-5");
  await expect(toast).toContainText(text, { timeout: 10_000 });
}

export async function waitForClipInSidebar(page: Page, name: string) {
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
}

export function shouldMockOllama(): boolean {
  return process.env.MOCK_OLLAMA === "1";
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const resp = await fetch("http://localhost:11434/api/tags");
    return resp.ok;
  } catch {
    return false;
  }
}
