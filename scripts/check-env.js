/**
 * Environment check — runs before `npm run dev` (via predev script).
 *
 * Non-blocking: warns if configuration is missing but never exits with
 * an error code. The app still starts — AI features gracefully degrade
 * to time-based fallback when the LLM provider is unreachable.
 */

const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", DIM = "\x1b[2m", RESET = "\x1b[0m";

function log(icon, msg) { console.log(`  ${icon} ${msg}`); }

function main() {
  const provider = (process.env.LLM_PROVIDER || "ollama-cloud").toLowerCase();

  console.log(`\n${DIM}── Environment Check ──${RESET}\n`);

  log(`${G}✓${RESET}`, `LLM_PROVIDER: ${provider}`);

  if (provider === "ollama-cloud") {
    const key = process.env.OLLAMA_API_KEY;
    const host = process.env.OLLAMA_CLOUD_HOST || "https://ollama.com";
    const model = process.env.LLM_MODEL || process.env.VISION_MODEL || "qwen3-vl:32b-thinking";

    if (!key) {
      log(`${Y}!${RESET}`, `OLLAMA_API_KEY is not set`);
      log(" ", `${DIM}Get your API key at: https://ollama.com/settings/keys${RESET}`);
      log(" ", `${DIM}Then add to .env:    OLLAMA_API_KEY=your-key-here${RESET}`);
      log(" ", `${DIM}AI features will use time-based fallback until key is configured.${RESET}`);
    } else {
      log(`${G}✓${RESET}`, `OLLAMA_API_KEY: set (${key.slice(0, 6)}...)`);
    }
    log(`${G}✓${RESET}`, `Host: ${host}`);
    log(`${G}✓${RESET}`, `Model: ${model}`);
  } else if (provider === "ollama") {
    const url = process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    log(`${G}✓${RESET}`, `Local Ollama: ${url}`);
    log(" ", `${DIM}Make sure Ollama is running: ollama serve${RESET}`);
  } else if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      log(`${Y}!${RESET}`, `OPENAI_API_KEY is not set — OpenAI calls will fail`);
    } else {
      log(`${G}✓${RESET}`, `OPENAI_API_KEY: set`);
    }
  } else if (provider === "openrouter") {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      log(`${Y}!${RESET}`, `OPENROUTER_API_KEY is not set — OpenRouter calls will fail`);
    } else {
      log(`${G}✓${RESET}`, `OPENROUTER_API_KEY: set`);
    }
  } else {
    log(`${Y}!${RESET}`, `Unknown LLM_PROVIDER: "${provider}" — defaulting to ollama-cloud behavior`);
  }

  console.log();
}

main();
