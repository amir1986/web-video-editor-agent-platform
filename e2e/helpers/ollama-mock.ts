import { Page } from "@playwright/test";

/** Intercept all Ollama network calls with canned responses. */
export async function mockOllama(page: Page) {
  // Mock /api/tags — model listing
  await page.route("**/api/tags", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          { name: "qwen2.5vl:7b", modified_at: "2025-01-01T00:00:00Z", size: 4_000_000_000 },
          { name: "llama3:8b", modified_at: "2025-01-01T00:00:00Z", size: 5_000_000_000 },
        ],
      }),
    });
  });

  // Mock /v1/chat/completions — AI agent responses
  await page.route("**/v1/chat/completions", (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const content = body.messages?.[0]?.content || "";
    const isVision = Array.isArray(content);

    // CUT agent response (vision call with images)
    if (isVision) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                segments: [
                  { id: "s1", src_in: 0, src_out: 2.5 },
                  { id: "s2", src_in: 3.0, src_out: 4.5 },
                ],
                cut_notes: "Mock cut analysis",
              }),
            },
          }],
        }),
      });
      return;
    }

    // All other agents — return a simple 2-segment plan
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              segments: [
                { id: "s1", src_in: 0, src_out: 2.5 },
                { id: "s2", src_in: 3.0, src_out: 4.5 },
              ],
            }),
          },
        }],
      }),
    });
  });
}
