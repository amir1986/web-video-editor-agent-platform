# Web Video Editor Agent Platform

A local-first web video editor that uses a multi-agent AI pipeline to automatically generate highlight reels from raw video. Runs entirely on localhost with no paid APIs — AI inference goes through a local [Ollama](https://ollama.com) instance.

## Features

- **Browser-based editor** — Import video, preview with playback controls, set In/Out markers, export trimmed clips
- **Multi-agent AI pipeline** — Five specialized agents collaborate to produce highlight edits:
  1. **Cut Agent** — Selects the strongest segments using vision-capable LLM
  2. **Structure Agent** — Reorders segments for narrative arc (hook -> buildup -> climax -> resolution)
  3. **Continuity Agent** — Smooths jarring cuts and adjusts segment boundaries
  4. **Transition Agent** — Assigns transition types (hard cut, fade, dissolve, dip to black)
  5. **Constraints Agent** — Validates the edit plan against duration, resolution, and overlap rules
- **One-click highlight export** — AI analyzes frames, builds an edit plan, renders with ffmpeg transitions, and downloads automatically
- **Telegram bot** — Send a video to the bot and get back a highlight reel (supports files >20MB via MTProto)
- **Local persistence** — Project state saved to IndexedDB in the browser

## Architecture

```
web-video-editor-agent-platform/
├── apps/
│   ├── web/          # React + TypeScript + Vite frontend
│   └── api/          # Node.js/Express API server
│       └── src/
│           ├── index.js       # REST API + ffmpeg rendering
│           ├── bot.js         # Telegram bot
│           └── ai/agents.js   # Multi-agent pipeline
└── packages/
    └── core/         # Shared TypeScript types (ProjectState, Clip, etc.)
```

- **`apps/web`** — Single-page editor UI with asset panel, video preview, timeline with In/Out markers, and AI agent panel. Communicates with the API server over HTTP.
- **`apps/api`** — Express server exposing `/api/analyze` (runs agent pipeline), `/api/auto-edit` (full render), and `/api/trim` (single-segment export). Uses ffmpeg for video processing and Ollama for AI inference.
- **`packages/core`** — TypeScript interfaces shared across workspaces.

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **ffmpeg** installed and available on PATH
- **Ollama** running locally with a vision model (default: `qwen2.5vl:7b`)

### Install and Run

```bash
# Install dependencies
npm install

# Start the API server (port 3001)
npm run dev --workspace=apps/api

# In another terminal, start the web UI (port 5173)
npm run dev --workspace=apps/web
```

Open http://localhost:5173, import a video, and click **Auto Edit with Vision**.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VISION_MODEL` | `qwen2.5vl:7b` | Ollama model for vision-capable agents |
| `TEXT_MODEL` | same as VISION_MODEL | Ollama model for text-only agents |
| `VITE_API_URL` | `http://localhost:3001` | API server URL (frontend) |

## Telegram Bot

The bot lets users send a video and receive a highlight reel directly in Telegram.

```bash
# Required
export TELEGRAM_BOT_TOKEN="your-bot-token"

# Optional — enables large file downloads (>20MB) via MTProto
export TELEGRAM_API_ID="your-api-id"
export TELEGRAM_API_HASH="your-api-hash"

# Start the bot
npm run bot --workspace=apps/api
```

Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from https://my.telegram.org.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite |
| Backend | Node.js, Express |
| Video processing | ffmpeg (CLI), ffmpeg.wasm (browser) |
| AI inference | Ollama (local, OpenAI-compatible API) |
| Telegram | node-telegram-bot-api, gramjs (MTProto) |
| Persistence | IndexedDB (browser) |

## License

This project is licensed under the [MIT License](LICENSE).
