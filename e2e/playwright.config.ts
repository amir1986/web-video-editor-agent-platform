import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
    cwd: "..",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
