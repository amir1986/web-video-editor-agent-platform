/**
 * Unified LLM client supporting both Ollama (local) and Claude API (cloud).
 *
 * Cookbook patterns applied:
 * - Tool use / function calling (Claude API)
 * - Prompt caching (Claude API cache_control)
 * - Retry with exponential backoff
 * - Streaming support
 *
 * Set LLM_PROVIDER=claude and ANTHROPIC_API_KEY to use Claude API.
 * Default: Ollama (local).
 */

const LLM_PROVIDER = process.env.LLM_PROVIDER || "ollama";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/v1/chat/completions";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const VISION_MODEL = process.env.VISION_MODEL || "qwen2.5vl:7b";
const TEXT_MODEL = process.env.TEXT_MODEL || VISION_MODEL;

// ---------------------------------------------------------------------------
// Retry with exponential backoff (cookbook pattern)
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
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: useVision ? VISION_MODEL : TEXT_MODEL,
      messages,
      temperature,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM returned no JSON: " + text.slice(0, 300));
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// Claude API client with tool use support (cookbook pattern)
// ---------------------------------------------------------------------------

async function claudeRequest(systemPrompt, userContent, options = {}) {
  const { tools = [], temperature = 0, useVision = false, enableCaching = true } = options;

  // Build messages — convert vision content to Claude format
  const userMessage = buildClaudeUserMessage(userContent, useVision);

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    temperature,
    system: enableCaching
      ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
      : systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };

  // Add tools if provided (cookbook tool use pattern)
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };

  // Enable prompt caching (cookbook pattern)
  if (enableCaching) {
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }

  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();

  // Log cache metrics if available
  if (data.usage?.cache_creation_input_tokens || data.usage?.cache_read_input_tokens) {
    console.log(`[CLAUDE-CACHE] created=${data.usage.cache_creation_input_tokens || 0}, read=${data.usage.cache_read_input_tokens || 0}`);
  }

  return data;
}

/**
 * Build Claude-format user message content.
 * Converts OpenAI-style image_url to Claude image blocks.
 */
function buildClaudeUserMessage(userContent, useVision) {
  if (typeof userContent === "string") return userContent;

  // Array of content blocks (vision format)
  if (Array.isArray(userContent)) {
    return userContent.map(block => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "image_url") {
        const url = block.image_url?.url || "";
        if (url.startsWith("data:image/")) {
          const [header, data] = url.split(",");
          const mediaType = header.match(/data:(image\/[^;]+)/)?.[1] || "image/jpeg";
          return { type: "image", source: { type: "base64", media_type: mediaType, data } };
        }
        return { type: "image", source: { type: "url", url } };
      }
      return block;
    });
  }

  return String(userContent);
}

// ---------------------------------------------------------------------------
// Claude agentic tool loop (cookbook pattern)
// ---------------------------------------------------------------------------

/**
 * Run Claude with tools in an agentic loop.
 * Claude calls tools, we execute them, feed results back until Claude stops.
 *
 * @param {string} systemPrompt - System prompt
 * @param {string|Array} userContent - User message
 * @param {Array} tools - Tool definitions (Claude format)
 * @param {object} toolHandlers - Map of tool name → async handler function
 * @param {object} options - { maxTurns, temperature, enableCaching }
 * @returns {object} Final response with text content and tool results
 */
async function claudeAgentLoop(systemPrompt, userContent, tools, toolHandlers, options = {}) {
  const { maxTurns = 5, temperature = 0, enableCaching = true } = options;
  const messages = [{ role: "user", content: buildClaudeUserMessage(userContent, true) }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      temperature,
      system: enableCaching
        ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
        : systemPrompt,
      messages,
      tools,
      tool_choice: { type: "auto" },
    };

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    };
    if (enableCaching) headers["anthropic-beta"] = "prompt-caching-2024-07-31";

    const res = await fetch(CLAUDE_API_URL, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();

    // Add assistant response to messages
    messages.push({ role: "assistant", content: data.content });

    // Check if Claude wants to use tools
    const toolUseBlocks = (data.content || []).filter(b => b.type === "tool_use");
    if (toolUseBlocks.length === 0 || data.stop_reason === "end_turn") {
      // Claude is done — extract final text/JSON
      const textBlock = (data.content || []).find(b => b.type === "text");
      return { content: data.content, text: textBlock?.text || "", usage: data.usage };
    }

    // Execute tools and build results
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const handler = toolHandlers[toolUse.name];
      let result;
      if (handler) {
        try {
          result = await handler(toolUse.input);
          console.log(`[TOOL] ${toolUse.name} → OK`);
        } catch (err) {
          result = { error: err.message };
          console.log(`[TOOL] ${toolUse.name} → ERROR: ${err.message}`);
        }
      } else {
        result = { error: `Unknown tool: ${toolUse.name}` };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(`Agent loop exceeded ${maxTurns} turns`);
}

// ---------------------------------------------------------------------------
// Unified request function
// ---------------------------------------------------------------------------

/**
 * Make an LLM request using the configured provider.
 * Falls back to Ollama if Claude API key is not set.
 *
 * @param {string} systemPrompt
 * @param {string|Array} userContent
 * @param {object} options - { useVision, temperature, tools, enableCaching }
 * @returns {object} Parsed JSON response
 */
async function llmRequest(systemPrompt, userContent, options = {}) {
  const provider = ANTHROPIC_API_KEY && LLM_PROVIDER === "claude" ? "claude" : "ollama";

  return withRetry(async () => {
    if (provider === "claude") {
      const response = await claudeRequest(systemPrompt, userContent, options);
      // Extract JSON from text response
      const textBlock = (response.content || []).find(b => b.type === "text");
      const text = textBlock?.text || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Claude returned no JSON: " + text.slice(0, 300));
      return JSON.parse(match[0]);
    } else {
      return ollamaRequest(systemPrompt, userContent, options);
    }
  }, { maxRetries: 2, label: provider.toUpperCase() });
}

// ---------------------------------------------------------------------------
// Streaming support (SSE)
// ---------------------------------------------------------------------------

/**
 * Stream Claude API response as Server-Sent Events.
 * Used for real-time pipeline progress to the web client.
 *
 * @param {string} systemPrompt
 * @param {string|Array} userContent
 * @param {object} options
 * @returns {AsyncGenerator} Yields text chunks
 */
async function* claudeStream(systemPrompt, userContent, options = {}) {
  const { temperature = 0, enableCaching = true } = options;

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    temperature,
    stream: true,
    system: enableCaching
      ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
      : systemPrompt,
    messages: [{ role: "user", content: buildClaudeUserMessage(userContent, false) }],
  };

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  if (enableCaching) headers["anthropic-beta"] = "prompt-caching-2024-07-31";

  const res = await fetch(CLAUDE_API_URL, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Claude stream HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          const event = JSON.parse(data);
          if (event.type === "content_block_delta" && event.delta?.text) {
            yield event.delta.text;
          }
        } catch {}
      }
    }
  }
}

module.exports = {
  llmRequest,
  claudeRequest,
  claudeAgentLoop,
  claudeStream,
  withRetry,
  LLM_PROVIDER,
  ANTHROPIC_API_KEY,
};
