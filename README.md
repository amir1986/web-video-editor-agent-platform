# Web Video Editor Agent Platform

Local-first web video editor powered by a multi-agent AI pipeline. Import a video, let AI select the best highlights, and export — via the web UI, REST API, Python CLI, or MCP server.

All AI runs through **Ollama** (local) — no API keys, no cloud dependencies.

## Quick Start

```bash
git clone https://github.com/amir1986/web-video-editor-agent-platform.git
cd web-video-editor-agent-platform
npm install

# Install Ollama: https://ollama.com
ollama pull qwen3-vl:8b-thinking

npm run dev
```

| Service | URL | What it does |
|---------|-----|-------------|
| Web UI | [localhost:5173](http://localhost:5173) | Browser-based video editor |
| API | [localhost:3001](http://localhost:3001) | Express server (ffmpeg + AI pipeline) |
| Bot | — | Multi-channel messaging bot (idle if no tokens set) |

**Requirements:** Node.js >= 18, ffmpeg/ffprobe on PATH, Ollama with `qwen3-vl:8b-thinking`.

> **No bot tokens?** Bot stays idle. **No `.env`?** Sensible defaults. **No Ollama?** ffmpeg endpoints still work.

## Web UI

1. **Import** — Drag-and-drop or click (`.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`, `.flv`, `.wmv`, `.m4v`)
2. **AI Auto-Edit** — 7-agent pipeline selects highlights via Ollama
3. **Approve & Learn** — Approve the edit so the AI learns your style
4. **Style Profile** — View progress, mode (Discovery / Guided), fingerprint, reset
5. **Timeline** — Click segments to jump, remove with ×, adjust In/Out
6. **Overlays & Audio** — Text overlays with position/timing, volume 0–200%
7. **Export** — Server-side ffmpeg render, downloaded to browser

Sessions auto-save to IndexedDB and restore after refresh.

## AI Pipeline

Default model: `qwen3-vl:8b-thinking` — override via `VISION_MODEL` / `TEXT_MODEL` env vars.

```
STYLE → CUT → STRUCTURE → CONTINUITY → TRANSITION → CONSTRAINTS → QUALITY GUARD → EditPlan
```

| Agent | Type | What it does |
|---|---|---|
| STYLE | Style Engine | Loads videographer fingerprint, injects into LLM prompts |
| CUT | LLM + vision | Selects 2–6 best segments from video frames |
| STRUCTURE | LLM | Reorders for best narrative arc |
| CONTINUITY | LLM | Smooths boundaries between adjacent cuts |
| TRANSITION | Deterministic | Assigns hard_cut / dissolve / fade / dip_to_black |
| CONSTRAINTS | Deterministic | Validates timing, removes overlaps, re-IDs segments |
| QUALITY GUARD | Deterministic | Enforces resolution, aspect ratio, codec settings |

LLM agents fall back to deterministic logic if the AI call fails.

### Adaptive Style Engine

The platform learns each videographer's editing style over time:

1. **Discovery mode** (projects 1–3) — AI decides autonomously.
2. **After each approval** — Qwen extracts a **style fingerprint** (opaque JSON — schema decided by Qwen, not the developer) and merges it with the existing one via weighted averaging.
3. **Guided mode** (project 4+) — Fingerprint injected into every LLM agent's prompt as the primary creative brief.

- Zero config on first use — style builds automatically
- Non-fatal: if Qwen fails, project count still increments
- Stored in SQLite (`data/styles.db`) — full SQL, indexes, no entry cap
- All entry points (Web UI, API, Telegram, WebChat) pass user identity
- Reset via UI or `DELETE /api/style-profile/:userId`

## API

| Method | Endpoint | Description | Ollama? |
|---|---|---|---|
| `POST` | `/api/auto-edit` | Full AI auto-edit — video in, video out (queued) | Yes |
| `GET` | `/api/auto-edit/status` | Queue position | No |
| `POST` | `/api/approve-delivery` | Approve edit, extract style fingerprint | Yes |
| `GET` | `/api/style-profile/:userId` | Style profile, fingerprint, history | No |
| `DELETE` | `/api/style-profile/:userId` | Reset style profile | No |
| `POST` | `/api/render` | Render an EditPlan | No |
| `POST` | `/api/trim` | Trim video (`?in=5&out=15`) | No |
| `POST` | `/api/overlay` | Burn text overlays | No |
| `POST` | `/api/adjust-audio` | Adjust volume (`?volume=150`) | No |
| `POST` | `/api/merge` | Merge multiple videos | No |

```bash
# AI auto-edit
curl -X POST http://localhost:3001/api/auto-edit \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" -o highlights.mp4

# Trim (no Ollama needed)
curl -X POST "http://localhost:3001/api/trim?in=5&out=15" \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" -o trimmed.mp4
```

## Configuration

All optional. `npm run dev` works without any `.env` file.

```bash
# apps/api/.env

OLLAMA_URL=http://localhost:11434/v1/chat/completions
VISION_MODEL=qwen3-vl:8b-thinking
TEXT_MODEL=qwen3-vl:8b-thinking
AUTH_SECRET=your-secret
PORT=3001
CORS_ORIGIN=http://localhost:5173
STYLE_DB_PATH=data/styles.db

WEBCHAT_ENABLED=true
WEBCHAT_PORT=3980

TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
```

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| AI | 7-agent pipeline, Ollama (Qwen3 VL), Adaptive Style Engine, RAG |
| Backend | Express.js, ffmpeg/ffprobe, SQLite |

## Project Structure

```
apps/web/          React + Tailwind + shadcn/ui
apps/api/          Express + ffmpeg + AI pipeline + Style Engine
packages/core/     Shared TypeScript types
data/styles.db     SQLite — fingerprints + delivery history (gitignored)
scripts/
  video_autopilot.py   Python GPU video editor
  check-deps.js        Dependency health checker
```

<details>
<summary>Processing Queue</summary>

Auto-edit requests are processed sequentially (single GPU VRAM constraint). `/api/auto-edit` queues in-memory (FIFO). Check with `GET /api/auto-edit/status`.
</details>

<details>
<summary>Python Video Autopilot (GPU)</summary>

Standalone script for GPU-accelerated editing, optimized for NVIDIA RTX 4070 (12GB VRAM). Handles 5s to 10h videos.

```bash
pip install -r scripts/requirements.txt
python scripts/video_autopilot.py input.mp4
python scripts/video_autopilot.py input.mp4 -o highlights.mp4 --keep-ratio 0.4
python scripts/video_autopilot.py input.mp4 --plan-only > edit_plan.json
```

**Pipeline:** PROBE → AUDIO (faster-whisper GPU) → VISION (Ollama qwen3-vl) → MERGE (consensus filter) → ASSEMBLE (ffmpeg).

Consensus: segment approved when audio RMS > threshold + speech detected + Qwen confidence > 0.8. Dynamic frame sampling adapts to video length. Checkpoints every 50 frames.

EditPlan output is compatible with `/api/render`:
```bash
python scripts/video_autopilot.py input.mp4 --plan-only > plan.json
curl -X POST http://localhost:3001/api/render \
  -F "video=@input.mp4" -F "editPlan=$(cat plan.json)" -o output.mp4
```
</details>

<details>
<summary>Messaging Channels (12 platforms)</summary>

Telegram, Discord, Slack, WhatsApp, Microsoft Teams, Google Chat, Signal, Matrix, iMessage, WebChat, Zalo OA, Zalo Personal. Set env vars to enable — unconfigured channels are skipped.

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
npm test          # API unit tests (38 tests)
npm run test:e2e  # Playwright E2E tests
npm run typecheck # TypeScript
npm run lint      # ESLint
```

## License

MIT
