# Web Video Editor Agent Platform

Local-first web video editor powered by a multi-agent AI pipeline. Import a video, let AI select the best highlights, and export — via the web UI, REST API, or MCP server.

The web UI uses **[Puter.js](https://js.puter.com/v2/)** for AI: no API keys, no backend LLM server required. Puter automatically creates a free guest session on first use (user-pays model).

## Quick Start

```bash
git clone https://github.com/amir1986/web-video-editor-agent-platform.git
cd web-video-editor-agent-platform
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) for the Web UI, API runs on [http://localhost:3001](http://localhost:3001).

**Requirements:** Node.js >= 18, ffmpeg.

> No `ANTHROPIC_API_KEY` needed for the web UI — AI runs via Puter.js in the browser.
> The backend API (ffmpeg trim/render/merge) still requires the Node server. Ollama or `ANTHROPIC_API_KEY` are only needed if you use the REST API or bot channels directly.

## Web UI

1. **Import** — Click "Import Video" or drag-and-drop
2. **AI Auto-Edit** — Click "Auto Edit with AI" to run the 6-agent pipeline
   - Runs free via Puter.js guest session — no sign-in required
   - Optionally sign in with a Puter account for a persistent quota
3. **Model** — Select any model from the dynamic dropdown (populated via `puter.ai.listModels()`)
4. **Timeline** — Click segments to jump, remove with ×, or use In/Out sliders
5. **Text Overlays** — Add text with size, color, position, and time range
6. **Audio** — Adjust volume (0–200%)
7. **Export** — Rendered via ffmpeg (server-side), downloaded to browser

Sessions auto-save to IndexedDB and restore after refresh.

## How AI Works in the Browser

The web UI uses **Puter.js v2** — a browser-native SDK that routes AI calls through Puter's infrastructure. No API keys are stored in the app or on the server.

```
Browser → puter.ai.chat() → Puter infrastructure → Claude / other models
```

**Auth flow:**
- **Guest (default, free):** Puter silently creates a temporary guest session on the first `puter.ai.chat()` call. No popup, no sign-in.
- **Signed-in user:** Click "Sign in" in the AI panel to use your Puter account quota instead.

**Model selection:**
- On page load, `puter.ai.listModels()` fetches all available models dynamically — no hardcoded model names.
- Defaults to the newest Claude Sonnet available, falling back to `claude-3-5-sonnet` → first model.
- Prefers `-latest` aliases when available (e.g. `claude-sonnet-latest`).

**Agent pipeline (runs fully in-browser):**

```
Frames → CUT → STRUCTURE → CONTINUITY → TRANSITION → CONSTRAINTS → QUALITY GUARD → EditPlan
```

| Agent | Type | What it does |
|---|---|---|
| CUT | LLM + vision | Selects 2–6 best segments from video frames |
| STRUCTURE | LLM | Reorders for best narrative arc |
| CONTINUITY | LLM | Smooths boundaries between adjacent cuts |
| TRANSITION | Deterministic | Assigns hard_cut / dissolve / fade / dip_to_black |
| CONSTRAINTS | Deterministic | Validates timing, removes overlaps, re-IDs segments |
| QUALITY GUARD | Deterministic | Enforces resolution, aspect ratio, codec settings |

Each LLM agent falls back to deterministic logic if the AI call fails.

## Configuration

Only needed for the backend API (ffmpeg operations) and bot channels:

```bash
# apps/api/.env

# LLM for REST API / bots (optional — web UI uses Puter.js instead)
ANTHROPIC_API_KEY=sk-ant-...     # Claude API (optional)
VISION_MODEL=qwen2.5vl:7b       # Ollama (default fallback)

# Auth (optional)
AUTH_SECRET=your-secret

# Server
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

## API

These endpoints power the ffmpeg operations (trim, render, merge, overlay). The web UI calls them directly; no AI key is needed for these.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auto-edit` | Full AI auto-edit — video in, video out (uses backend LLM) |
| `POST` | `/api/render` | Render an EditPlan |
| `POST` | `/api/trim` | Trim video (`?in=5&out=15`) |
| `POST` | `/api/overlay` | Burn text overlays |
| `POST` | `/api/adjust-audio` | Adjust volume (`?volume=150`) |
| `POST` | `/api/merge` | Merge multiple videos |

> `/api/analyze` is no longer used by the web UI — AI analysis runs in the browser via Puter.js.

```bash
# Full auto-edit via REST (uses backend LLM, requires ANTHROPIC_API_KEY or Ollama)
curl -X POST http://localhost:3001/api/auto-edit \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" -o highlights.mp4

# Trim
curl -X POST "http://localhost:3001/api/trim?in=5&out=15" \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" -o trimmed.mp4
```

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Lucide icons |
| AI (browser) | Puter.js v2 — user-pays, no API keys, guest sessions free |
| AI (server) | Multi-agent pipeline (6 agents), Ollama / Claude API, RAG knowledge base |
| Backend | Express.js, ffmpeg/ffprobe |
| Persistence | IndexedDB (client), filesystem (server) |

## Project Structure

```
apps/web/        Frontend (React + Tailwind + shadcn/ui + Puter.js)
apps/api/        Backend (Express + ffmpeg + AI pipeline)
packages/core/   Shared TypeScript types
```

<details>
<summary>Messaging Channels (12 platforms)</summary>

Supports Telegram, Discord, Slack, WhatsApp, Microsoft Teams, Google Chat, Signal, Matrix, iMessage, WebChat, Zalo OA, and Zalo Personal. Set the relevant env vars to enable a channel — unconfigured channels are skipped.

```bash
npm run dev:bot   # Start multi-channel bot
```

See `apps/api/src/channels/` for adapters and required env vars.
</details>

<details>
<summary>MCP Server</summary>

```bash
node apps/api/src/mcp-server.js
```

Claude Desktop config:

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["apps/api/src/mcp-server.js"]
    }
  }
}
```

Tools: `probe_video`, `extract_frames`, `analyze_scene`, `search_knowledge`, `calculate_pacing`.
</details>

## Testing

```bash
npm test
```

## License

MIT
