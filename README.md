# Web Video Editor Agent Platform

An open-source, local-first web video editor powered by a multi-agent AI pipeline. Send a video and get an automatically edited result — via the web UI, REST API, or Telegram bot.

The AI pipeline uses local LLMs (Ollama) to analyze video frames and produce an **EditPlan** JSON that drives ffmpeg for rendering. No paid APIs, no cloud uploads — everything runs on your machine.

## Features

- **Web UI** — Import video, preview, trim with In/Out markers, export via ffmpeg.wasm
- **Auto-Edit API** — Upload a video, get back an AI-edited version (cuts, transitions, quality-matched output)
- **Telegram Bot** — Send a video to your bot, receive the edited result
- **Multi-Agent Pipeline** — Cut → Structure → Continuity → Transition → Constraints → Quality Guard
- **Source Quality Matching** — Probes the original video and encodes output at the same bitrate, resolution, and fps
- **Auto-Restart Dev Mode** — All services use `--watch` for instant reload on file changes

## Architecture

```
apps/web          React + TypeScript + Vite (browser UI)
apps/api          Express.js API gateway + ffmpeg orchestration
  src/index.js      API server (trim, auto-edit, analyze endpoints)
  src/bot.js        Telegram bot (polling mode)
  src/ai/agents.js  Multi-agent LLM pipeline
packages/core     Shared TypeScript types and timeline operations
```

## Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| **Node.js** | >= 18 | Runtime (`--watch` requires 18+) |
| **npm** | >= 8 | Package manager (workspaces support) |
| **ffmpeg** | any recent | Video processing |
| **ffprobe** | any recent | Video analysis (ships with ffmpeg) |
| **Ollama** | any recent | Local LLM inference for auto-edit |

### Platform-Specific Setup

#### Linux / macOS

Install ffmpeg from your package manager:

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install ffmpeg

# macOS (Homebrew)
brew install ffmpeg
```

Install Ollama: https://ollama.com/download

#### Windows (WSL)

This project runs ffmpeg/ffprobe through WSL on Windows. You need:

1. **WSL 2** with a Linux distro installed (default: `Ubuntu-24.04`)
2. **ffmpeg** installed inside your WSL distro:
   ```bash
   wsl -d Ubuntu-24.04 -- sudo apt update
   wsl -d Ubuntu-24.04 -- sudo apt install ffmpeg
   ```
3. If your distro has a different name, set the `WSL_DISTRO` environment variable (see below)

## Installation

```bash
git clone https://github.com/amir1986/web-video-editor-agent-platform.git
cd web-video-editor-agent-platform
npm install
```

## Environment Variables

Create a `.env` file in `apps/api/` (it is git-ignored):

```bash
# --- Required for Telegram Bot only ---
TELEGRAM_BOT_TOKEN=your-bot-token-from-@BotFather

# --- Optional ---
# WSL distro name (Windows only, default: Ubuntu-24.04)
WSL_DISTRO=Ubuntu-24.04

# CORS origin for the web UI (default: http://localhost:5173)
CORS_ORIGIN=http://localhost:5173

# Telegram Bot internal API URL (default: http://localhost:3001)
API_URL=http://localhost:3001

# Telegram MTProto credentials (for large file downloads >20MB)
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=your-api-hash

# Ollama model names (default: qwen2.5vl:7b)
VISION_MODEL=qwen2.5vl:7b
TEXT_MODEL=qwen2.5vl:7b
```

## Running

### Start Everything (Recommended)

From the project root, one command starts all three services with auto-restart:

```bash
npm run dev
```

This runs concurrently with labeled, colored output:
- `[api]` — API server on http://localhost:3001 (auto-restarts on file changes)
- `[bot]` — Telegram bot (auto-restarts on file changes)
- `[web]` — Vite dev server on http://localhost:5173 (HMR)

### Start Services Individually

```bash
# API server only (with auto-restart)
npm run dev:api

# Telegram bot only (with auto-restart)
npm run dev:bot

# Web UI only (with HMR)
npm run dev:web
```

### Production

```bash
# API server
cd apps/api && node src/index.js

# Telegram bot
cd apps/api && node src/bot.js

# Web UI (build and serve)
cd apps/web && npm run build
# Serve the dist/ folder with any static file server
```

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/analyze` | Analyze a video file — returns duration, resolution, fps, codec info |
| `POST` | `/api/trim` | Trim a video by time range — send raw video bytes with query params `in` and `out` |
| `POST` | `/api/auto-edit` | AI-powered auto-edit — analyzes frames, runs multi-agent pipeline, renders result |
| `GET` | `/api/health` | Health check |

### Trim Example

```bash
curl -X POST "http://localhost:3001/api/trim?in=5&out=15" \
  --data-binary @input.mp4 \
  -H "Content-Type: video/mp4" \
  --output trimmed.mp4
```

### Auto-Edit Example

```bash
curl -X POST "http://localhost:3001/api/auto-edit" \
  --data-binary @input.mp4 \
  -H "Content-Type: video/mp4" \
  --output edited.mp4
```

## Telegram Bot Usage

1. Create a bot with [@BotFather](https://t.me/BotFather) and get the token
2. Set `TELEGRAM_BOT_TOKEN` in your `.env` file
3. Start the bot: `npm run dev:bot`
4. Send any video to your bot — it will auto-edit and reply with the result

For videos larger than 20MB, you also need `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from https://my.telegram.org.

## Ollama Setup

The auto-edit pipeline requires a local LLM. Install and pull a vision model:

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the default vision model
ollama pull qwen2.5vl:7b
```

Ollama must be running on `http://localhost:11434` (the default).

## Project Scripts

| Script | Scope | Description |
|---|---|---|
| `npm run dev` | Root | Start API + Bot + Web concurrently with auto-restart |
| `npm run dev:api` | Root | Start API server with `--watch` |
| `npm run dev:bot` | Root | Start Telegram bot with `--watch` |
| `npm run dev:web` | Root | Start Vite dev server |
| `npm run build` | Root | Build the web UI for production |
| `npm run lint` | Root | Lint the web UI |
| `npm run typecheck` | Root | Type-check the web UI |

## License

MIT — see [LICENSE](LICENSE).
