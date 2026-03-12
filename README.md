# Web Video Editor Agent Platform

Local-first web video editor powered by a multi-agent AI pipeline. Import a video, let AI select the best highlights, and export — via the web UI, REST API, Python CLI, or MCP server.

The web UI uses **[Puter.js](https://js.puter.com/v2/)** for AI: no API keys, no backend LLM server required. Puter automatically creates a free guest session on first use (user-pays model).

## Quick Start

```bash
git clone https://github.com/amir1986/web-video-editor-agent-platform.git
cd web-video-editor-agent-platform
npm install
npm run dev
```

This single command starts everything:

| Service | URL | What it does |
|---------|-----|-------------|
| Web UI | [http://localhost:5173](http://localhost:5173) | Browser-based video editor (Puter.js AI) |
| API | [http://localhost:3001](http://localhost:3001) | Express server (ffmpeg, AI pipeline) |
| Bot | — | Multi-channel messaging bot (idle if no tokens set) |

**Requirements:** Node.js >= 18, ffmpeg/ffprobe installed and on PATH.

> **No extra setup needed.** `npm run dev` works out of the box — the web UI runs AI via Puter.js in the browser, and the bot stays idle until messaging tokens are configured. Ollama is only needed for the REST API's AI endpoints (`/api/auto-edit`).

### Optional: Ollama for REST API AI

If you want the backend AI pipeline (for REST API or bots), install Ollama and pull the Qwen model:

```bash
# Install Ollama: https://ollama.com
ollama pull qwen2.5vl:7b
```

## What `npm run dev` Starts

```
npm run dev
  ├── api   → Express server on :3001 (always works, ffmpeg endpoints ready)
  ├── bot   → Multi-channel bot (stays idle if no tokens configured)
  └── web   → Vite dev server on :5173 (React UI, no config needed)
```

- **No Ollama?** — Web UI still works (uses Puter.js). API's ffmpeg endpoints (trim, render, merge) still work. Only `/api/auto-edit` needs Ollama.
- **No bot tokens?** — Bot prints available channels and stays idle. Does not crash.
- **No `.env` file?** — Everything uses sensible defaults.

## Web UI

1. **Import** — Click "Import Video" or drag-and-drop
2. **AI Auto-Edit** — Click "Auto Edit with AI" to run the 6-agent pipeline
   - Runs free via Puter.js guest session — no sign-in required
   - Optionally sign in with a Puter account for a persistent quota
3. **Model** — Select any model from the dynamic dropdown (populated via `puter.ai.listModels()`)
4. **Timeline** — Click segments to jump, remove with ×, or use In/Out sliders
5. **Text Overlays** — Add text with size, color, position, and time range
6. **Audio** — Adjust volume (0-200%)
7. **Export** — Rendered via ffmpeg (server-side), downloaded to browser

Sessions auto-save to IndexedDB and restore after refresh.

## Python Video Autopilot (GPU)

Standalone Python script for GPU-accelerated video editing, optimized for NVIDIA RTX 4070 (12GB VRAM). Handles videos from 5 seconds to 10 hours.

```bash
# Install Python dependencies
pip install -r scripts/requirements.txt

# Basic usage — produces highlights reel
python scripts/video_autopilot.py input.mp4

# Custom output path and keep ratio
python scripts/video_autopilot.py input.mp4 -o highlights.mp4 --keep-ratio 0.4

# Output EditPlan JSON only (no rendering) — compatible with /api/render
python scripts/video_autopilot.py input.mp4 --plan-only > edit_plan.json

# Resume after crash (uses checkpoint file)
python scripts/video_autopilot.py input.mp4 --resume .input_autopilot_checkpoint.json
```

**Requirements:** Python >= 3.10, ffmpeg/ffprobe, NVIDIA GPU (CUDA), Ollama with qwen2.5vl:7b.

### How it works

```
Phase 0: PROBE    → ffprobe metadata (duration, codec, fps, bitrate)
Phase 1: AUDIO    → faster-whisper (GPU) → speech timestamps → free VRAM
Phase 2: VISION   → Ollama qwen2.5-vl → frame classification (batched)
Phase 3: MERGE    → consensus filter → segment list → EditPlan JSON
Phase 4: ASSEMBLE → ffmpeg -c copy (lossless) or filter_complex
```

**VRAM management ("4070 switch"):** Whisper loads on GPU for speech detection, then the model is deleted and `torch.cuda.empty_cache()` frees VRAM before vision analysis starts. This keeps peak VRAM under 8GB.

**Consensus filtering:** A segment is approved only when all three conditions are met:
- Audio RMS intensity > threshold (audible content)
- Whisper detects speech (`is_speech = True`)
- Qwen-VL confidence score > 0.8

A 3-second buffer is added to the start and end of every approved cut.

**Dynamic sampling** adapts to video length:

| Duration | Sample rate |
|----------|------------|
| < 1 min | 1 frame/sec |
| 1–10 min | 1 frame/5s |
| 10–60 min | 1 frame/10s |
| > 1 hour | 1 frame/20s |

**Resilience:** Checkpointing every 50 frames (resume with `--resume`).

**EditPlan compatibility:** The JSON output is compatible with the existing `/api/render` endpoint:

```bash
# Generate plan with Python, render with Node API
python scripts/video_autopilot.py input.mp4 --plan-only > plan.json
curl -X POST http://localhost:3001/api/render \
  -F "video=@input.mp4" -F "editPlan=$(cat plan.json)" -o output.mp4
```

## How AI Works in the Browser

The web UI uses **Puter.js v2** — a browser-native SDK that routes AI calls through Puter's infrastructure. No API keys are stored in the app or on the server.

```
Browser → puter.ai.chat() → Puter infrastructure → AI models
```

**Auth flow:**
- **Guest (default, free):** Puter silently creates a temporary guest session on the first `puter.ai.chat()` call. No popup, no sign-in.
- **Signed-in user:** Click "Sign in" in the AI panel to use your Puter account quota instead.

**Model selection:**
- On page load, `puter.ai.listModels()` fetches all available models dynamically — no hardcoded model names.
- Prefers `-latest` aliases when available.

**Agent pipeline (runs fully in-browser):**

```
Frames → CUT → STRUCTURE → CONTINUITY → TRANSITION → CONSTRAINTS → QUALITY GUARD → EditPlan
```

| Agent | Type | What it does |
|---|---|---|
| CUT | LLM + vision | Selects 2-6 best segments from video frames |
| STRUCTURE | LLM | Reorders for best narrative arc |
| CONTINUITY | LLM | Smooths boundaries between adjacent cuts |
| TRANSITION | Deterministic | Assigns hard_cut / dissolve / fade / dip_to_black |
| CONSTRAINTS | Deterministic | Validates timing, removes overlaps, re-IDs segments |
| QUALITY GUARD | Deterministic | Enforces resolution, aspect ratio, codec settings |

Each LLM agent falls back to deterministic logic if the AI call fails.

## Configuration

All configuration is optional. `npm run dev` works without any `.env` file.

```bash
# apps/api/.env (optional)

# LLM — only needed for /api/auto-edit and bot AI features
OLLAMA_URL=http://localhost:11434/v1/chat/completions   # default
VISION_MODEL=qwen2.5vl:7b                              # default
TEXT_MODEL=qwen2.5vl:7b                                 # default

# Auth (optional — disabled by default)
AUTH_SECRET=your-secret

# Server (optional)
PORT=3001
CORS_ORIGIN=http://localhost:5173

# Bot channels (optional — set any to enable that channel)
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
```

## API

These endpoints power the ffmpeg operations (trim, render, merge, overlay). The web UI calls them directly; no AI key is needed for these.

| Method | Endpoint | Description | Needs Ollama? |
|---|---|---|---|
| `POST` | `/api/auto-edit` | Full AI auto-edit — video in, video out | Yes |
| `POST` | `/api/render` | Render an EditPlan | No |
| `POST` | `/api/trim` | Trim video (`?in=5&out=15`) | No |
| `POST` | `/api/overlay` | Burn text overlays | No |
| `POST` | `/api/adjust-audio` | Adjust volume (`?volume=150`) | No |
| `POST` | `/api/merge` | Merge multiple videos | No |

> `/api/analyze` is no longer used by the web UI — AI analysis runs in the browser via Puter.js.

```bash
# Full auto-edit via REST (needs Ollama running)
curl -X POST http://localhost:3001/api/auto-edit \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" -o highlights.mp4

# Trim (no Ollama needed)
curl -X POST "http://localhost:3001/api/trim?in=5&out=15" \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" -o trimmed.mp4
```

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Lucide icons |
| AI (browser) | Puter.js v2 — user-pays, no API keys, guest sessions free |
| AI (server) | Multi-agent pipeline (6 agents), Ollama (Qwen 2.5 VL), RAG knowledge base |
| AI (Python) | faster-whisper (GPU), Qwen 2.5 VL via Ollama, ffmpeg scene detection |
| Backend | Express.js, ffmpeg/ffprobe |
| Persistence | IndexedDB (client), filesystem (server) |

## Project Structure

```
apps/web/          Frontend (React + Tailwind + shadcn/ui + Puter.js)
apps/api/          Backend (Express + ffmpeg + AI pipeline)
packages/core/     Shared TypeScript types
scripts/
  video_autopilot.py   Python GPU video editor (RTX 4070 optimized)
  requirements.txt     Python dependencies
  check-deps.js        Dependency health checker
```

<details>
<summary>Messaging Channels (12 platforms)</summary>

Supports Telegram, Discord, Slack, WhatsApp, Microsoft Teams, Google Chat, Signal, Matrix, iMessage, WebChat, Zalo OA, and Zalo Personal. Set the relevant env vars to enable a channel — unconfigured channels are skipped (bot stays idle).

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

Tools: `probe_video`, `extract_frames`, `analyze_scene`, `search_knowledge`, `calculate_pacing`.
</details>

## Testing

```bash
npm test
```

## License

MIT
