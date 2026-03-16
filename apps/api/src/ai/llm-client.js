/**
 * LLM client — multi-provider with Ollama Cloud API as default.
 *
 * Provider switching via LLM_PROVIDER env var:
 *   ollama-cloud — Ollama Cloud API via `ollama` npm package (default)
 *                  Remote inference on Ollama's GPUs, no local install.
 *                  Auth: OLLAMA_API_KEY from https://ollama.com/settings/keys
 *   ollama       — Local Ollama instance (OpenAI-compatible, no key needed)
 *   openai       — OpenAI API (needs OPENAI_API_KEY)
 *   openrouter   — OpenRouter (needs OPENROUTER_API_KEY)
 *
 * Default model: qwen3-vl:32b-thinking
 *
 * Agents call llmRequest(systemPrompt, userContent, { useVision }).
 * This module handles provider routing and format conversion internally.
 */

const LLM_PROVIDER = (process.env.LLM_PROVIDER || "ollama-cloud").toLowerCase();

const DEFAULT_MODEL = "qwen3-vl:32b-thinking";
const VISION_MODEL = process.env.VISION_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL;
const TEXT_MODEL   = process.env.TEXT_MODEL   || VISION_MODEL;

// ---------------------------------------------------------------------------
// Provider: Ollama Cloud API (via `ollama` npm package, native format)
// ---------------------------------------------------------------------------

const { Ollama } = require("ollama");

const OLLAMA_CLOUD_HOST = process.env.OLLAMA_CLOUD_HOST || "https://ollama.com";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";

const ollamaCloudClient = new Ollama({
  host: OLLAMA_CLOUD_HOST,
  ...(OLLAMA_API_KEY ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } } : {}),
});

// ---------------------------------------------------------------------------
// Provider: Local Ollama / OpenAI / OpenRouter (OpenAI-compatible format)
// ---------------------------------------------------------------------------

const LOCAL_PROVIDER_CONFIG = {
  ollama: {
    url: (process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://localhost:11434")
      .replace(/\/?$/, "").replace(/\/v1\/?$/, "") + "/v1/chat/completions",
    apiKey: null,
  },
  openai: {
    url: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/?$/, "") + "/chat/completions",
    apiKey: process.env.OPENAI_API_KEY || null,
  },
  openrouter: {
    url: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/?$/, "") + "/chat/completions",
    apiKey: process.env.OPENROUTER_API_KEY || null,
  },
};

// Use undici for local/OpenAI/OpenRouter providers (extended timeouts for vision)
const { Agent, fetch: undiciFetch } = require("undici");
const LLM_AGENT = new Agent({ headersTimeout: 5 * 60 * 1000, bodyTimeout: 5 * 60 * 1000 });

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------

let _logged = false;
function logProviderOnce() {
  if (_logged) return;
  _logged = true;
  if (LLM_PROVIDER === "ollama-cloud") {
    console.log(`[LLM] Provider: ollama-cloud | Host: ${OLLAMA_CLOUD_HOST} | Vision: ${VISION_MODEL} | Text: ${TEXT_MODEL} | Key: ${OLLAMA_API_KEY ? "set" : "MISSING"}`);
  } else {
    const cfg = LOCAL_PROVIDER_CONFIG[LLM_PROVIDER] || LOCAL_PROVIDER_CONFIG.ollama;
    const baseUrl = cfg.url.replace(/\/v1\/chat\/completions$/, "").replace(/\/chat\/completions$/, "");
    console.log(`[LLM] Provider: ${LLM_PROVIDER} | Vision: ${VISION_MODEL} | Text: ${TEXT_MODEL} | URL: ${baseUrl}`);
  }
}

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
// Think-block stripping + JSON extraction (shared by all providers)
// ---------------------------------------------------------------------------

function extractJsonFromLLMText(text) {
  // Qwen "thinking" models wrap reasoning in <think>…</think> before the
  // actual answer. Strip the thinking block so the JSON regex doesn't pick
  // up malformed fragments from the reasoning chain.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Handle unclosed <think> tags (truncated responses)
  if (text.includes("<think>")) {
    text = text.replace(/<think>[\s\S]*/g, "").trim();
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM returned no JSON: " + text.slice(0, 300));

  let jsonStr = match[0];
  try {
    return JSON.parse(jsonStr);
  } catch (firstErr) {
    // Repair common LLM JSON errors:
    const repaired = jsonStr
      .replace(/\}\s*\{/g, "},{")       // missing comma between objects
      .replace(/\]\s*\[/g, "],[")       // missing comma between arrays
      .replace(/,\s*([}\]])/g, "$1")    // trailing commas
      .replace(/'/g, '"');               // single quotes
    try {
      console.log(`[LLM] JSON repair: fixed malformed response (${firstErr.message})`);
      return JSON.parse(repaired);
    } catch {
      console.log(`[LLM] JSON parse failed even after repair. Raw: ${jsonStr.slice(0, 500)}`);
      throw firstErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Ollama Cloud request (native Ollama API format via `ollama` npm package)
// ---------------------------------------------------------------------------

/**
 * Convert agent userContent (OpenAI vision format) to Ollama native format.
 * OpenAI: [{ type: "text", text: "..." }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }]
 * Ollama: { content: "...", images: ["<base64>"] }
 */
function convertToOllamaFormat(systemPrompt, userContent, useVision) {
  const messages = [{ role: "system", content: systemPrompt }];

  if (!useVision || typeof userContent === "string") {
    messages.push({ role: "user", content: typeof userContent === "string" ? userContent : JSON.stringify(userContent) });
    return messages;
  }

  // Vision: extract text and images from OpenAI-format array
  let textParts = [];
  let images = [];
  for (const item of userContent) {
    if (item.type === "text") {
      textParts.push(item.text);
    } else if (item.type === "image_url" && item.image_url?.url) {
      // Strip data URI prefix — Ollama expects raw base64
      const base64 = item.image_url.url.replace(/^data:image\/[^;]+;base64,/, "");
      images.push(base64);
    }
  }

  messages.push({
    role: "user",
    content: textParts.join("\n"),
    ...(images.length > 0 ? { images } : {}),
  });

  return messages;
}

async function ollamaCloudRequest(systemPrompt, userContent, options = {}) {
  logProviderOnce();
  const { useVision = false, temperature = 0 } = options;
  const model = useVision ? VISION_MODEL : TEXT_MODEL;
  const messages = convertToOllamaFormat(systemPrompt, userContent, useVision);

  const response = await ollamaCloudClient.chat({
    model,
    messages,
    stream: false,
    options: { temperature },
  });

  const text = response.message?.content || "";
  console.log(`[OLLAMA-CLOUD] Response (${text.length} chars, model=${model}, vision=${useVision})`);
  return extractJsonFromLLMText(text);
}

// ---------------------------------------------------------------------------
// Local / OpenAI / OpenRouter request (OpenAI-compatible format via undici)
// ---------------------------------------------------------------------------

async function openaiCompatRequest(systemPrompt, userContent, options = {}) {
  logProviderOnce();
  const { useVision = false, temperature = 0 } = options;
  const providerCfg = LOCAL_PROVIDER_CONFIG[LLM_PROVIDER] || LOCAL_PROVIDER_CONFIG.ollama;
  const model = useVision ? VISION_MODEL : TEXT_MODEL;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
  const headers = { "Content-Type": "application/json" };
  if (providerCfg.apiKey) headers["Authorization"] = `Bearer ${providerCfg.apiKey}`;

  const res = await undiciFetch(providerCfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, temperature, stream: false }),
    dispatcher: LLM_AGENT,
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.log(`[${LLM_PROVIDER.toUpperCase()}] HTTP ${res.status} error (model=${model}): ${errBody.slice(0, 200)}`);
    throw new Error(`${LLM_PROVIDER} HTTP ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  console.log(`[${LLM_PROVIDER.toUpperCase()}] Response (${text.length} chars, model=${model}, vision=${useVision})`);
  return extractJsonFromLLMText(text);
}

// ---------------------------------------------------------------------------
// Unified request function — routes to the active provider
// ---------------------------------------------------------------------------

/**
 * Make an LLM request. Provider is selected via LLM_PROVIDER env var.
 *
 * @param {string} systemPrompt
 * @param {string|Array} userContent - String for text, Array for vision (OpenAI format)
 * @param {object} options - { useVision, temperature }
 * @returns {object} Parsed JSON response
 */
async function llmRequest(systemPrompt, userContent, options = {}) {
  // Vision calls are expensive (60-120s). Don't retry — one attempt is enough.
  const maxRetries = options.useVision ? 0 : 2;

  const requestFn = LLM_PROVIDER === "ollama-cloud"
    ? () => ollamaCloudRequest(systemPrompt, userContent, options)
    : () => openaiCompatRequest(systemPrompt, userContent, options);

  return withRetry(requestFn, { maxRetries, label: LLM_PROVIDER.toUpperCase() });
}

// ---------------------------------------------------------------------------
// Health check — fast connectivity probe
// ---------------------------------------------------------------------------

/**
 * Check if the LLM provider is reachable. Returns true/false without throwing.
 */
async function isOllamaAvailable() {
  try {
    if (LLM_PROVIDER === "ollama-cloud") {
      // Use the ollama SDK to list models — lightweight check
      const models = await Promise.race([
        ollamaCloudClient.list(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
      return !!(models?.models);
    }
    // Local Ollama / OpenAI — HTTP health check
    const baseUrl = (LOCAL_PROVIDER_CONFIG[LLM_PROVIDER] || LOCAL_PROVIDER_CONFIG.ollama)
      .url.replace(/\/v1\/chat\/completions$/, "").replace(/\/chat\/completions$/, "");
    const res = await undiciFetch(`${baseUrl}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = {
  llmRequest,
  withRetry,
  isOllamaAvailable,
};
