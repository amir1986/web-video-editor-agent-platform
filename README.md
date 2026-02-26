# Web Video Editor Agent Platform

Local-first web video editor powered by a multi-agent AI pipeline. Send a video and get an automatically edited highlight reel — via the web UI, REST API, 12 messaging platforms, or MCP server.

Supports both local LLMs (Ollama) and the Claude API. Analyzes video frames, produces an EditPlan JSON, and renders via ffmpeg.

## Features

- **Web UI** — Import, preview, AI auto-edit, text overlays, audio controls, multi-segment timeline, export, light/dark theme, drag-and-drop, multi-file merge, session persistence
- **12 Messaging Channels** — Telegram, Discord, Slack, WhatsApp, Microsoft Teams, Google Chat, Signal, Matrix, iMessage (BlueBubbles), WebChat, Zalo OA, Zalo Personal
- **Multi-Agent Pipeline** — CUT → STRUCTURE → CONTINUITY → TRANSITION → CONSTRAINTS → QUALITY GUARD
- **Auto-Edit API** — Upload video, get back AI-edited highlight reel with source-matched quality
- **MCP Server** — Expose editing tools to Claude Desktop, Claude Code, or any MCP client
- **Source Quality Matching** — Output encoded at the same bitrate, resolution, and fps as the input
- **Token Auth** — Optional HMAC-based auth with 24h expiry
- **SSE Streaming** — Real-time progress from each pipeline agent
- **RAG Knowledge Base** — Editing best practices injected into agent prompts
- **Dual LLM** — Auto-detects Claude API key, falls back to Ollama
- **27 Tests** — Agents, knowledge base, tools, auth, MCP, pipeline integration

## Architecture

```
apps/
  web/                  React + TypeScript + Vite
    src/App.tsx           Main app — timeline, preview, AI panel, overlays, audio
    src/export.ts         Client-side export via API
    src/frameExtractor.ts Frame extraction for AI analysis
    src/utils/indexedDB.ts Session persistence
  api/                  Express.js + ffmpeg
    src/index.js          API routes, auth, rendering engine
    src/bot.js            Multi-channel bot entry point
    src/mcp-server.js     MCP server (stdio)
    src/test.js           27-test backend suite
    src/channels/         Channel adapters
      base.js             Shared processing pipeline
      index.js            Channel manager (auto-discovery)
      telegram.js         Telegram (Bot API + MTProto)
      discord.js          Discord (discord.js)
      slack.js            Slack (@slack/bolt, Socket Mode)
      whatsapp.js         WhatsApp (whatsapp-web.js)
      teams.js            Microsoft Teams (botbuilder)
      matrix.js           Matrix (matrix-bot-sdk)
      signal.js           Signal (signal-cli JSON-RPC)
      google-chat.js      Google Chat (googleapis)
      imessage.js         iMessage (BlueBubbles HTTP API)
      webchat.js          WebChat (WebSocket)
      zalo.js             Zalo OA (REST API)
      zalo-personal.js    Zalo Personal (REST API)
    src/ai/
      agents.js           Multi-agent pipeline (6 agents)
      llm-client.js       Unified LLM client (Ollama + Claude)
      tools.js            Tool definitions for Claude tool use
      knowledge-base.js   RAG knowledge base
packages/
  core/                 Shared TypeScript types
```

## Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| Node.js | >= 18 | Runtime |
| npm | >= 8 | Package manager (workspaces) |
| ffmpeg + ffprobe | any recent | Video processing |
| Ollama | any recent | Local LLM (optional if using Claude API) |

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install ffmpeg

# macOS
brew install ffmpeg

# Windows — runs ffmpeg through WSL
wsl --install
wsl -d Ubuntu-24.04 -- sudo apt update && sudo apt install ffmpeg
```

## Installation

```bash
git clone https://github.com/amir1986/web-video-editor-agent-platform.git
cd web-video-editor-agent-platform
npm install
```

## Environment Variables

Create `.env` in `apps/api/`:

```bash
# LLM — pick one
ANTHROPIC_API_KEY=sk-ant-...          # Claude API
VISION_MODEL=qwen2.5vl:7b            # Ollama (default)
TEXT_MODEL=qwen2.5vl:7b

# Auth (optional)
AUTH_SECRET=your-secret-password

# Server
PORT=3001
CORS_ORIGIN=http://localhost:5173

# Channels — set any to enable
TELEGRAM_BOT_TOKEN=your-token
TELEGRAM_API_ID=12345678              # MTProto for >20MB files
TELEGRAM_API_HASH=your-hash
DISCORD_BOT_TOKEN=your-token
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
WHATSAPP_ENABLED=true
TEAMS_APP_ID=your-app-id
TEAMS_APP_PASSWORD=your-password
MATRIX_HOMESERVER_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=your-token
SIGNAL_PHONE=+1234567890
GOOGLE_CHAT_CREDENTIALS=/path/to/service-account.json
BLUEBUBBLES_URL=http://192.168.1.100:1234
BLUEBUBBLES_PASSWORD=your-password
WEBCHAT_ENABLED=true
ZALO_OA_ACCESS_TOKEN=your-token
ZALO_PERSONAL_ACCESS_TOKEN=your-token

# Windows only
WSL_DISTRO=Ubuntu-24.04
```

## Running

```bash
# All services (API + bot + web)
npm run dev

# Individual
npm run dev:api   # API on http://localhost:3001
npm run dev:bot   # Multi-channel bot
npm run dev:web   # Web UI on http://localhost:5173
```

The bot auto-discovers which channels have env vars set. Unconfigured channels are skipped.

### Production

```bash
npm run build
node apps/api/src/index.js   # Serves API + built frontend on :3001
```

## Messaging Channels

| Channel | Env Vars | Upload Limit | SDK |
|---|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` | 50MB (compress) | node-telegram-bot-api + MTProto |
| Discord | `DISCORD_BOT_TOKEN` | 25-100MB (boost tier) | discord.js |
| Slack | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | unlimited | @slack/bolt |
| WhatsApp | `WHATSAPP_ENABLED` | 64MB | whatsapp-web.js |
| Microsoft Teams | `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD` | 250MB | botbuilder |
| Matrix | `MATRIX_HOMESERVER_URL` + `MATRIX_ACCESS_TOKEN` | 50MB | matrix-bot-sdk |
| Signal | `SIGNAL_PHONE` | 100MB | signal-cli daemon |
| Google Chat | `GOOGLE_CHAT_CREDENTIALS` | 200MB | googleapis |
| iMessage | `BLUEBUBBLES_URL` + `BLUEBUBBLES_PASSWORD` | 100MB | BlueBubbles API |
| WebChat | `WEBCHAT_ENABLED` | unlimited | ws (WebSocket) |
| Zalo OA | `ZALO_OA_ACCESS_TOKEN` | 25MB | Zalo REST API |
| Zalo Personal | `ZALO_PERSONAL_ACCESS_TOKEN` | 25MB | Zalo REST API |

Channel SDKs are optional dependencies — install only what you need:

```bash
npm install discord.js        # Discord
npm install @slack/bolt        # Slack
npm install whatsapp-web.js    # WhatsApp
npm install botbuilder         # Teams
npm install matrix-bot-sdk     # Matrix
npm install googleapis         # Google Chat
npm install ws                 # WebChat
```

Telegram, Signal, iMessage, and Zalo use built-in Node modules or REST APIs — no extra packages needed.

## Web UI

1. **Import** — Click "Import Video" or drag-and-drop. Supports multiple files.
2. **AI Auto-Edit** — Click "Auto Edit with AI". Pipeline shows each agent step with elapsed time and estimate.
3. **Edit** — Click segments to jump. Remove with X. Drag In/Out sliders for manual trim.
4. **Merge** — Import 2+ videos, drag to reorder, click "Merge".
5. **Overlays** — Text tab: add text with size, color, position, time range.
6. **Audio** — Audio tab: volume 0-200%.
7. **Export** — Rendered server-side with ffmpeg, downloaded to browser.
8. **Session** — Auto-saved to IndexedDB. Restored after refresh.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Get auth token |
| `GET` | `/api/auth/verify` | Verify token |
| `POST` | `/api/analyze` | AI analysis (NDJSON stream) |
| `POST` | `/api/render` | Render EditPlan (video + `X-Edit-Plan` header) |
| `POST` | `/api/trim` | Trim video (`?in=5&out=15&name=clip`) |
| `POST` | `/api/auto-edit` | Full AI auto-edit |
| `POST` | `/api/auto-edit-stream` | Auto-edit with SSE progress |
| `POST` | `/api/overlay` | Burn text overlays (`X-Overlays` header) |
| `POST` | `/api/adjust-audio` | Adjust volume (`?volume=150`) |
| `POST` | `/api/merge` | Merge videos (multipart `videos` field) |
| `GET` | `/api/health` | Health check |

When `AUTH_SECRET` is not set, all endpoints are open.

```bash
# AI auto-edit
curl -X POST http://localhost:3001/api/auto-edit \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" --output highlights.mp4

# Trim
curl -X POST "http://localhost:3001/api/trim?in=5&out=15&name=clip" \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" --output trimmed.mp4

# Text overlay
curl -X POST "http://localhost:3001/api/overlay?name=titled" \
  --data-binary @input.mp4 -H "Content-Type: video/mp4" \
  -H 'X-Overlays: [{"text":"Hello","x":50,"y":10,"fontSize":32,"color":"white","from":0,"to":5}]' \
  --output output.mp4
```

## Multi-Agent Pipeline

```
Frames → CUT → STRUCTURE → CONTINUITY → TRANSITION → CONSTRAINTS → QUALITY GUARD → EditPlan
```

Each agent uses the LLM with a domain-specific prompt and RAG context. Falls back to deterministic logic when the LLM is unavailable.

## MCP Server

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

## Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5vl:7b
```

Runs on `http://localhost:11434`. If `ANTHROPIC_API_KEY` is set, Claude API is used instead.

## Testing

```bash
npm test   # 27 tests
```

Covers: knowledge base, agents, tools, auth, MCP, LLM client, pipeline integration.

## CI/CD

PRs run: lint, typecheck, schema validation, build, AI review, conflict resolution, auto-merge.

| Workflow | File | Trigger |
|---|---|---|
| CI | `ci.yml` | PR / push to master |
| Evaluation | `eval.yml` | PR / push to master |
| AI PR Review | `pr-review.yml` | PR opened/updated |
| Conflict Resolver | `merge-conflict.yml` | PR opened/updated |
| Auto Commit | `auto-commit.yml` | `/ai-run` comment on issue |
| Auto Merge | `auto-merge.yml` | Checks pass |

## License

MIT
