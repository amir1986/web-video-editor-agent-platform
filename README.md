# Web Video Editor Agent Platform

An open-source, local-first web video editor powered by a multi-agent AI pipeline. Send a video and get an automatically edited highlight reel — via the web UI, REST API, Telegram bot, or MCP server.

The AI pipeline supports both local LLMs (Ollama) and the Claude API. It analyzes video frames and produces an **EditPlan** JSON that drives ffmpeg for rendering. Optional token-based authentication, text overlays, audio controls, and real-time SSE progress streaming are all built in.

## Features

- **Web UI** — Import video, preview, AI auto-edit, text overlays, audio volume control, multi-segment timeline, export via server-side ffmpeg
- **Auto-Edit API** — Upload a video, get back an AI-edited highlight reel (cuts, transitions, quality-matched output)
- **Telegram Bot** — Send a video to your bot, receive the edited result (supports files >20MB via MTProto)
- **Multi-Agent Pipeline** — Cut → Structure → Continuity → Transition → Constraints → Quality Guard
- **MCP Server** — Expose editing tools to any MCP-compatible AI client (Claude Desktop, Claude Code)
- **Source Quality Matching** — Probes the original video and encodes output at the same bitrate, resolution, and fps
- **Token Authentication** — Optional HMAC-based auth with 24-hour token expiry
- **Text Overlays** — Add timed text overlays with position, size, and color controls; burned into export via ffmpeg drawtext
- **Audio Controls** — Adjust volume (0–200%), mute, or boost audio for exports
- **SSE Streaming** — Real-time progress events from each pipeline agent via Server-Sent Events
- **RAG Knowledge Base** — Editing best practices injected into agent prompts for better decisions
- **Dual LLM Support** — Auto-detects Claude API key; falls back to Ollama for fully local operation
- **27 Tests** — Backend test suite covering agents, knowledge base, tools, auth, MCP, and pipeline integration
- **CI/CD Pipeline** — Lint, type-check, schema validation, build, AI PR review, auto-merge

## Architecture

```
apps/
  web/                  React + TypeScript + Vite (browser UI)
    src/App.tsx           Main app — timeline, preview, AI panel, overlays, audio
    src/export.ts         Client-side export via API endpoints
    src/frameExtractor.ts Frame extraction for AI analysis
    src/utils/indexedDB.ts Local project state persistence
  api/                  Express.js API server + ffmpeg orchestration
    src/index.js          API routes, auth, ffmpeg wrappers, rendering engine
    src/bot.js            Telegram bot (polling mode)
    src/mcp-server.js     MCP server (JSON-RPC over stdio)
    src/test.js           27-test backend suite
    src/ai/
      agents.js           Multi-agent pipeline (6 agents)
      llm-client.js       Unified LLM client (Ollama + Claude API)
      tools.js            Tool definitions + handlers for Claude tool use
      knowledge-base.js   RAG knowledge base for editing decisions
packages/
  core/                 Shared TypeScript types and timeline operations
docs/
  ai/
    constraints.md      Editing constraint rules
    eval_scenarios/     20 JSON scenarios for CI validation
.github/
  workflows/            CI, eval, PR review, conflict resolver, auto-commit, auto-merge
  scripts/              Python scripts for Claude API integrations
```

## Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| **Node.js** | >= 18 | Runtime (`--watch` requires 18+) |
| **npm** | >= 8 | Package manager (workspaces support) |
| **ffmpeg** | any recent | Video processing |
| **ffprobe** | any recent | Video analysis (ships with ffmpeg) |
| **Ollama** | any recent | Local LLM inference (optional if using Claude API) |

### Platform-Specific Setup

#### Linux / macOS

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install ffmpeg

# macOS (Homebrew)
brew install ffmpeg
```

Install Ollama: https://ollama.com/download

#### Windows (PowerShell via WSL)

This project runs ffmpeg/ffprobe through WSL on Windows:

```powershell
# 1. Ensure WSL 2 is installed with a Linux distro
wsl --install

# 2. Install ffmpeg inside your WSL distro
wsl -d Ubuntu-24.04 -- sudo apt update
wsl -d Ubuntu-24.04 -- sudo apt install ffmpeg

# 3. (Optional) If your distro has a different name, set WSL_DISTRO
$env:WSL_DISTRO="YourDistroName"
```

## Installation

```bash
git clone https://github.com/amir1986/web-video-editor-agent-platform.git
cd web-video-editor-agent-platform
npm install
```

## Environment Variables

Create a `.env` file in `apps/api/` (it is git-ignored):

```bash
# --- LLM Provider (pick one) ---
# Option A: Claude API (recommended for best results)
ANTHROPIC_API_KEY=sk-ant-...

# Option B: Ollama (default — fully local, no API key needed)
VISION_MODEL=qwen2.5vl:7b        # default
TEXT_MODEL=qwen2.5vl:7b           # default

# --- Authentication (optional) ---
# Set to enable token-based auth on all endpoints.
# When unset, all endpoints are open (no auth required).
AUTH_SECRET=your-secret-password

# --- Server ---
PORT=3001                          # API port (default: 3001)
CORS_ORIGIN=http://localhost:5173  # Allowed CORS origin (default: http://localhost:5173)

# --- Telegram Bot (optional) ---
TELEGRAM_BOT_TOKEN=your-bot-token-from-@BotFather
API_URL=http://localhost:3001      # Bot's internal API URL (default)

# Telegram MTProto credentials (for large file downloads >20MB)
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=your-api-hash

# --- Windows only ---
WSL_DISTRO=Ubuntu-24.04           # WSL distro name (default)
```

## Running

### Start Everything (Recommended)

One command starts all three services with auto-restart:

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

### PowerShell (Windows)

```powershell
# Navigate to project
cd C:\path\to\web-video-editor-agent-platform

# Install dependencies
npm install

# Start everything
npm run dev

# -- OR start individually --
npm run dev:api   # API on http://localhost:3001
npm run dev:web   # Web on http://localhost:5173
npm run dev:bot   # Bot (needs TELEGRAM_BOT_TOKEN)
```

To set environment variables in PowerShell:

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:AUTH_SECRET="my-password"
$env:TELEGRAM_BOT_TOKEN="123456:ABC..."
npm run dev
```

### Production

```bash
# Build web frontend + start API server (serves both on port 3001)
npm run build
node apps/api/src/index.js
```

Open http://localhost:3001 — the API server serves the built frontend automatically.

### Docker

```bash
docker build -t videoagent .
docker run -p 3001:3001 videoagent
```

The Docker image includes ffmpeg, builds the frontend, and serves everything on port 3001.

## Web UI Usage

1. **Import** — Click "Import Video" to load a video file
2. **Preview** — Play/pause, scrub the timeline, see timecodes
3. **AI Auto-Edit** — Click "Auto Edit with AI" in the AI Agent tab. The pipeline runs 6 agents in sequence, with real-time progress updates. The resulting segments appear as colored blocks on the timeline.
4. **Edit Segments** — Click a segment to jump to it. Click the X button to remove it. Drag In/Out sliders for manual trim (when no AI segments).
5. **Text Overlays** — Switch to the "Text" tab. Add overlays with custom text, size, color, position (X/Y), and time range.
6. **Audio** — Switch to the "Audio" tab. Adjust volume 0-200% with presets (Mute, 50%, 100%, 150%).
7. **Export** — Click "Export" in the sidebar. The video is sent to the server, rendered with ffmpeg, and downloaded to your browser.

## API Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | No | Get an auth token (pass `{ password }` when `AUTH_SECRET` is set) |
| `GET` | `/api/auth/verify` | Yes | Verify a token is valid |
| `POST` | `/api/analyze` | Yes | AI analysis for web client — streams NDJSON progress, returns EditPlan |
| `POST` | `/api/render` | Yes | Render a pre-built EditPlan (no AI) — send video + `X-Edit-Plan` header |
| `POST` | `/api/trim` | Yes | Trim a video — query params `in`, `out`, `name` |
| `POST` | `/api/auto-edit` | Yes | Full AI auto-edit — send video, get back highlight reel |
| `POST` | `/api/auto-edit-stream` | Yes | Same as auto-edit but with SSE progress events |
| `POST` | `/api/overlay` | Yes | Burn text overlays — send video + `X-Overlays` header |
| `POST` | `/api/adjust-audio` | Yes | Adjust audio volume — query param `volume` (0-200) |
| `GET` | `/api/health` | No | Health check |

> **Note:** When `AUTH_SECRET` is not set, all endpoints are open (no token needed).

### Examples

**Get auth token:**

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your-secret"}'
```

**Trim a video:**

```bash
curl -X POST "http://localhost:3001/api/trim?in=5&out=15&name=clip" \
  --data-binary @input.mp4 \
  -H "Content-Type: video/mp4" \
  -H "Authorization: Bearer <token>" \
  --output trimmed.mp4
```

**AI auto-edit:**

```bash
curl -X POST http://localhost:3001/api/auto-edit \
  --data-binary @input.mp4 \
  -H "Content-Type: video/mp4" \
  -H "Authorization: Bearer <token>" \
  --output highlights.mp4
```

**Add text overlays:**

```bash
curl -X POST "http://localhost:3001/api/overlay?name=titled" \
  --data-binary @input.mp4 \
  -H "Content-Type: video/mp4" \
  -H 'X-Overlays: [{"text":"Hello World","x":50,"y":10,"fontSize":32,"color":"white","from":0,"to":5}]' \
  --output output.mp4
```

**Adjust audio volume:**

```bash
curl -X POST "http://localhost:3001/api/adjust-audio?volume=150&name=louder" \
  --data-binary @input.mp4 \
  -H "Content-Type: video/mp4" \
  --output louder.mp4
```

## Multi-Agent Pipeline

The AI pipeline runs 6 specialized agents in sequence:

```
Frame Extraction
  |
  v
CUT AGENT --------- Selects which parts to keep (2-6 segments)
  |                  Uses vision LLM + RAG knowledge base
  v
STRUCTURE AGENT --- Reorders segments for narrative flow
  |                  Arranges by energy/story arc
  v
CONTINUITY AGENT -- Checks visual/temporal consistency
  |                  Validates smooth transitions between segments
  v
TRANSITION AGENT -- Assigns transition types between segments
  |                  hard_cut, dissolve, fade, dip_to_black, wipe
  v
CONSTRAINTS AGENT - Validates the plan against rules
  |                  Duration, overlap, boundary checks
  v
QUALITY GUARD ----- Final audit pass
  |                  Ensures all constraints are met
  v
EditPlan JSON ----- Ready for ffmpeg rendering
```

Each agent uses the LLM with a domain-specific prompt, RAG context from the knowledge base, and falls back to deterministic logic when the LLM is unavailable.

## MCP Server

The platform includes an MCP (Model Context Protocol) server that exposes editing tools to AI clients:

```bash
# Start the MCP server (stdio transport)
node apps/api/src/mcp-server.js
```

**Claude Desktop configuration:**

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

Available MCP tools: `probe_video`, `extract_frames`, `analyze_scene`, `search_knowledge`, `calculate_pacing`, and more.

## Telegram Bot Usage

1. Create a bot with [@BotFather](https://t.me/BotFather) and get the token
2. Set `TELEGRAM_BOT_TOKEN` in your `.env` file
3. Start the bot: `npm run dev:bot`
4. Send any video to your bot — it will auto-edit and reply with the result

For videos larger than 20MB, you also need `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from https://my.telegram.org.

## Ollama Setup

The auto-edit pipeline can use a local LLM via Ollama. Install and pull a vision model:

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the default vision model
ollama pull qwen2.5vl:7b
```

Ollama must be running on `http://localhost:11434` (the default). If `ANTHROPIC_API_KEY` is set, the system uses the Claude API instead.

## Testing

Run the full backend test suite (27 tests):

```bash
npm test
```

Tests cover:
- **Knowledge Base** — search, filtering, context generation (5 tests)
- **Agents** — fallback cut logic, segment bounds validation (4 tests)
- **Tools** — tool definitions, handlers, pacing calculations (4 tests)
- **Auth** — token generation, verification, expiry, tampering (4 tests)
- **MCP Server** — initialize, tools/list, resources, error handling (5 tests)
- **LLM Client** — retry logic, provider detection (3 tests)
- **Pipeline Integration** — full end-to-end EditPlan generation (1 test)

## Project Scripts

| Script | Scope | Description |
|---|---|---|
| `npm run dev` | Root | Start API + Bot + Web concurrently with auto-restart |
| `npm run dev:api` | Root | Start API server with `--watch` |
| `npm run dev:bot` | Root | Start Telegram bot with `--watch` |
| `npm run dev:web` | Root | Start Vite dev server (HMR) |
| `npm run build` | Root | Build the web UI for production |
| `npm run lint` | Root | Lint the web UI with ESLint |
| `npm run typecheck` | Root | Type-check the web UI with TypeScript |
| `npm test` | Root | Run 27 backend tests |

## CI/CD Pipeline

Every Pull Request goes through an automated pipeline:

```
PR Opened / Updated
  |
  +-- CI Checks (parallel)
  |     +-- Lint ------------ ESLint on web UI source
  |     +-- Type Check ------ TypeScript --noEmit
  |     +-- Validate Schemas- Python eval of 20 scenario files
  |     +-- Build ----------- Vite production build (after lint + typecheck)
  |
  +-- Evaluation ------------ Validates all 20 eval scenarios
  |
  +-- AI PR Review ---------- Claude reviews diff for security + quality
  |
  +-- Merge Conflict Check -- Claude suggests conflict resolutions
        |
        v
  All checks pass -> Auto-merge (if labeled 'auto-merge' or Dependabot PR)
```

### Workflows

| Workflow | Trigger | File | Description |
|---|---|---|---|
| **CI** | PR or push to `master` | `.github/workflows/ci.yml` | Lint, typecheck, schema validation, build |
| **Evaluation** | PR or push to `master` | `.github/workflows/eval.yml` | Validates 20 eval scenario files |
| **AI PR Review** | PR opened / updated | `.github/workflows/pr-review.yml` | Claude reviews the diff and posts a comment |
| **Merge Conflict Resolver** | PR opened / updated | `.github/workflows/merge-conflict.yml` | Detects conflicts and posts AI resolution suggestions |
| **Auto Commit Task** | `/ai-run` comment on issue | `.github/workflows/auto-commit.yml` | Claude generates files from instructions, commits and pushes |
| **Auto Merge** | Checks pass / PR review | `.github/workflows/auto-merge.yml` | Auto-merges Dependabot PRs or PRs labeled `auto-merge` |

### CI Setup

1. **Add your Claude API key** to GitHub Secrets:
   - Go to **Settings > Secrets and variables > Actions > New repository secret**
   - Name: `ANTHROPIC_API_KEY`, Value: your key from [console.anthropic.com](https://console.anthropic.com)

2. **(Recommended) Enable branch protection** on `master`:
   - Go to **Settings > Branches > Add branch protection rule**
   - Branch name pattern: `master`
   - Enable: **Require status checks to pass before merging**
   - Required checks: `Lint`, `Type Check`, `Build`, `Validate Schemas`

3. **(Optional) Add notification webhooks**:
   - `SLACK_WEBHOOK_URL` — Slack incoming webhook URL
   - `DISCORD_WEBHOOK_URL` — Discord webhook URL

### CI Usage

- **CI Checks** run automatically on every PR — lint, typecheck, and build must pass before merging.
- **AI PR Reviews** happen automatically — Claude comments on every PR within a couple of minutes.
- **Conflict Resolution** is automatic — if a PR has merge conflicts, Claude posts suggested resolutions.
- **Auto-Merge** — add the `auto-merge` label to any PR to merge it automatically once all checks pass.
- **On-Demand Tasks** — comment `/ai-run <instruction>` on any issue, e.g.:
  ```
  /ai-run Create a blog post about Python tips and save it to blog/python-tips.md
  ```
  Claude will generate the file, commit, and push it.

### CI Scripts

| Script | Purpose |
|---|---|
| `.github/scripts/review_pr.py` | Fetches diff, calls Claude API, posts review comment |
| `.github/scripts/resolve_conflict.py` | Reads conflict markers, calls Claude API, posts suggestion |
| `.github/scripts/run_task.py` | Parses `/ai-run` instruction, generates files via Claude |
| `eval_script.py` | Validates 20 eval scenario files against JSON schema |

## License

MIT — see [LICENSE](LICENSE).
