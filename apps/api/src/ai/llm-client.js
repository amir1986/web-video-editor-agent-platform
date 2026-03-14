/**
 * LLM client for Ollama (local Qwen models).
 *
 * Patterns applied:
 * - Retry with exponential backoff
 * - Vision support via Qwen3 VL
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/v1/chat/completions";
// Default model — change here or override via env var.
// Kept as a single constant so model swaps are a one-line change.
const DEFAULT_MODEL = "qwen3-vl:8b-thinking";
const VISION_MODEL = process.env.VISION_MODEL || DEFAULT_MODEL;
const TEXT_MODEL   = process.env.TEXT_MODEL   || VISION_MODEL;

// Use undici directly so we can set headersTimeout/bodyTimeout beyond the
// 30-second undici default. Vision calls can take 60–120s.
const { Agent, fetch: undiciFetch } = require("undici");
const LLM_AGENT = new Agent({ headersTimeout: 5 * 60 * 1000, bodyTimeout: 5 * 60 * 1000 });

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

async function withRetry(fn, { maxRetries = 3, baseDelay = 1000, label = "llm" } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        console.log(`[${label}] Attempt ${attempt + 1} failed: ${err.message}. Retrying in ${(delay / 1000).toFixed(1)}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Ollama client (OpenAI-compatible)
// ---------------------------------------------------------------------------

async function ollamaRequest(systemPrompt, userContent, options = {}) {
  const { useVision = false, temperature = 0 } = options;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
  const res = await undiciFetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: useVision ? VISION_MODEL : TEXT_MODEL,
      messages,
      temperature,
      stream: false,
    }),
    dispatcher: LLM_AGENT,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = data.choices?.[0]?.message?.content || "";

  // Qwen "thinking" models wrap reasoning in <think>…</think> before the
  // actual answer. Strip the thinking block so the JSON regex doesn't pick
  // up malformed fragments from the reasoning chain.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM returned no JSON: " + text.slice(0, 300));
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// Unified request function
// ---------------------------------------------------------------------------

/**
 * Make an LLM request via Ollama.
 *
 * @param {string} systemPrompt
 * @param {string|Array} userContent
 * @param {object} options - { useVision, temperature }
 * @returns {object} Parsed JSON response
 */
async function llmRequest(systemPrompt, userContent, options = {}) {
  return withRetry(async () => {
    return ollamaRequest(systemPrompt, userContent, options);
  }, { maxRetries: 2, label: "OLLAMA" });
}

module.exports = {
  llmRequest,
  withRetry,
};
