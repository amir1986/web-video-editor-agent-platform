# Web Video Editor Agent Platform

A local-first web video editor that uses a multi-agent AI pipeline to automatically generate highlight reels from raw video. Runs entirely on localhost with no paid APIs — AI inference goes through a local [Ollama](https://ollama.com) instance.

## Features

- **Browser-based editor** — Import video, preview with playback controls, set In/Out markers, export trimmed clips
- **Multi-agent AI pipeline** — Six specialized agents collaborate to produce highlight edits:
  1. **Cut Agent** — Selects the strongest segments using vision-capable LLM
  2. **Structure Agent** — Reorders segments for narrative arc (hook → buildup → climax → resolution)
  3. **Continuity Agent** — Smooths jarring cuts and adjusts segment boundaries
  4. **Transition Agent** — Assigns transition types (hard cut, fade, dissolve, dip to black)
  5. **Constraints Agent** — Validates the edit plan against duration, resolution, and overlap rules
  6. **Quality Guard Agent** — Audits encoding settings, auto-corrects quality regressions
- **One-click highlight export** — AI analyzes frames, builds an edit plan, renders with ffmpeg transitions, and downloads automatically
- **Telegram bot** — Send a video to the bot and get back a highlight reel (supports files >20MB via MTProto)
- **Codec compatibility** — Automatically detects and re-encodes HEVC/VP9/AV1 sources to universally playable H.264
- **Local persistence** — Project state saved to IndexedDB in the browser

## Architecture

```
web-video-editor-agent-platform/
├── apps/
│   ├── web/                # React + TypeScript + Vite frontend
│   │   └── src/
│   │       ├── App.tsx             # Main editor UI
│   │       ├── export.ts           # Export functions (trim + edit plan)
│   │       ├── frameExtractor.ts   # Frame extraction for AI analysis
│   │       └── utils/indexedDB.ts  # Project persistence
│   └── api/                # Node.js/Express API server
│       └── src/
│           ├── index.js            # REST API + ffmpeg rendering
│           ├── bot.js              # Telegram bot
│           └── ai/
│               ├── agents.js                # Multi-agent pipeline
│               └── editplan.v1.schema.json  # EditPlan JSON schema
└── packages/
    └── core/               # Shared TypeScript types (ProjectState, Clip, etc.)
```

### How it works

1. **Web UI** — The React frontend captures frames from the imported video and sends them to the API server for AI analysis. The user can also manually set In/Out markers for single-segment trimming.

2. **API Server** — Receives frames, runs the multi-agent pipeline through Ollama, produces an EditPlan (JSON describing segments + transitions), then renders the final video using ffmpeg.

3. **Telegram Bot** — Accepts video messages, downloads them (Bot API for ≤20MB, MTProto for larger files), sends to the auto-edit API, compresses if the output exceeds Telegram's 50MB upload limit, and sends back the result.

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **ffmpeg** and **ffprobe** installed and available on PATH
- **Ollama** running locally with a vision model (default: `qwen2.5vl:7b`)

### Install and Run

```bash
# Install dependencies
npm install

# Pull the default vision model
ollama pull qwen2.5vl:7b

# Start the API server (port 3001)
npm run dev --workspace=apps/api

# In another terminal, start the web UI (port 5173)
npm run dev --workspace=apps/web
```

Open http://localhost:5173, import a video, and click **Auto Edit with Vision**.

### Windows (WSL)

On Windows, ffmpeg/ffprobe are invoked through WSL. Set the `WSL_DISTRO` environment variable to match your installed distribution:

```bash
set WSL_DISTRO=Ubuntu-24.04
```

The default is `Ubuntu`. Make sure ffmpeg is installed inside your WSL distro (`sudo apt install ffmpeg`).

## AI Pipeline

The multi-agent pipeline processes video in six stages. Only the first three use LLM inference; the rest are deterministic.

| Stage | Agent | Uses LLM | Purpose |
|-------|-------|----------|---------|
| 1 | **Cut** | Vision | Selects 2–6 strongest segments (30–60% of original) |
| 2 | **Structure** | Text | Reorders for narrative arc, merges close segments, splits long ones |
| 3 | **Continuity** | Text | Adjusts boundaries ±0.5s for flow, flags soft transitions |
| 4 | **Transition** | No | Assigns `hard_cut`, `fade`, `dissolve`, or `dip_to_black` |
| 5 | **Constraints** | No | Validates boundaries, removes overlaps, clamps to [0, duration] |
| 6 | **Quality Guard** | No | Audits encoding settings (CRF, preset, resolution), auto-corrects regressions |

**Fallback**: If AI inference fails, a deterministic time-based segmentation is used (keeps 2–4 segments covering the strongest portions).

### EditPlan Format

The pipeline outputs an EditPlan JSON document:

```json
{
  "render_constraints": {
    "keep_resolution": true,
    "keep_aspect_ratio": true,
    "no_stretch": true,
    "target_width": 1920,
    "target_height": 1080,
    "codec": "libx264",
    "crf": 18,
    "preset": "medium",
    "pixel_format": "yuv420p",
    "fps": 30,
    "fps_mode": "cfr"
  },
  "segments": [
    { "id": "s1", "src_in": 2.5, "src_out": 10.0 },
    { "id": "s2", "src_in": 25.0, "src_out": 38.5 }
  ],
  "transitions": [
    { "from": "s1", "to": "s2", "type": "hard_cut" }
  ],
  "quality_guard": {
    "constraints_ok": true,
    "checks": {
      "resolution_unchanged": true,
      "aspect_ratio_unchanged": true,
      "no_stretch": true,
      "no_unnecessary_reencode": true,
      "export_settings_not_platform_default": true,
      "fps_preserved": true,
      "sar_dar_correct": true
    }
  }
}
```

Full schema: [`apps/api/src/ai/editplan.v1.schema.json`](apps/api/src/ai/editplan.v1.schema.json)

## API Reference

Base URL: `http://localhost:3001`

### `POST /api/analyze`

Runs the multi-agent pipeline on extracted frames. Used by the web UI.

**Request body** (JSON):
```json
{
  "duration": 120.5,
  "frames": ["data:image/jpeg;base64,...", "..."],
  "width": 1920,
  "height": 1080,
  "fps": 30
}
```

**Response** (JSON):
```json
{
  "editPlan": { "segments": [...], "transitions": [...], ... },
  "segments": [...],
  "summary": "3 highlights selected"
}
```

### `POST /api/trim`

Trims a single segment from the uploaded video.

**Query params**: `in` (seconds), `out` (seconds), `name` (filename)

**Request body**: Raw video binary (`Content-Type: video/mp4`)

**Response**: MP4 file download. Uses stream copy for H.264 yuv420p sources, re-encodes otherwise.

### `POST /api/auto-edit`

Full highlight reel: probes video, extracts frames, runs AI pipeline, renders EditPlan.

**Query params**: `name` (filename)

**Request body**: Raw video binary (`Content-Type: video/mp4`)

**Response**: MP4 file download with headers `X-AI-Summary` and `X-Segments-Count`.

### `GET /api/health`

Returns `{ "status": "ok" }`.

## Telegram Bot

The bot lets users send a video and receive a highlight reel directly in Telegram.

```bash
# Required
export TELEGRAM_BOT_TOKEN="your-bot-token"

# Optional — enables large file downloads (>20MB) via MTProto
export TELEGRAM_API_ID="your-api-id"
export TELEGRAM_API_HASH="your-api-hash"

# Start the bot (API server must be running)
npm run bot --workspace=apps/api
```

Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from https://my.telegram.org.

The bot accepts videos sent as messages or documents. If the output exceeds Telegram's 50MB upload limit, it is automatically compressed with a calculated bitrate to fit.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VISION_MODEL` | `qwen2.5vl:7b` | Ollama model for vision-capable agents (Cut Agent) |
| `TEXT_MODEL` | same as `VISION_MODEL` | Ollama model for text-only agents (Structure, Continuity) |
| `VITE_API_URL` | `http://localhost:3001` | API server URL (frontend, set in `.env`) |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin for the API server |
| `WSL_DISTRO` | `Ubuntu` | WSL distribution name (Windows only) |
| `API_URL` | `http://localhost:3001` | API server URL (used by bot) |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token (required for bot) |
| `TELEGRAM_API_ID` | — | Telegram API ID for MTProto (optional) |
| `TELEGRAM_API_HASH` | — | Telegram API hash for MTProto (optional) |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite |
| Backend | Node.js, Express |
| Video processing | ffmpeg/ffprobe (CLI), ffmpeg.wasm (browser) |
| AI inference | Ollama (local, OpenAI-compatible API) |
| Telegram | node-telegram-bot-api, gramjs (MTProto) |
| Persistence | IndexedDB (browser) |

## License

This project is licensed under the [MIT License](LICENSE).
