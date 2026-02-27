# Web Video Editor Agent Platform

Local-first web video editor powered by a multi-agent AI pipeline. Import a video, let AI select the best highlights, and export — via the web UI, REST API, or MCP server.

## Quick Start

```bash
git clone https://github.com/amir1986/web-video-editor-agent-platform.git
cd web-video-editor-agent-platform
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) for the Web UI, API runs on [http://localhost:3001](http://localhost:3001).

**Requirements:** Node.js >= 18, ffmpeg, Ollama (or set `ANTHROPIC_API_KEY` for Claude).

## Web UI

1. **Import** — Click "Import Video" or drag-and-drop
2. **AI Auto-Edit** — Click "Auto Edit with AI" to run the 6-agent pipeline
3. **Timeline** — Click segments to jump, remove with X, or use In/Out sliders
4. **Text Overlays** — Add text with size, color, position, and time range
5. **Audio** — Adjust volume (0–200%)
6. **Export** — Rendered server-side via ffmpeg, downloaded to browser

Sessions auto-save to IndexedDB and restore after refresh.

## Configuration

Create `apps/api/.env`:

```bash
# LLM (pick one)
ANTHROPIC_API_KEY=sk-ant-...     # Claude API
VISION_MODEL=qwen2.5vl:7b       # Ollama (default)

# Auth (optional)
AUTH_SECRET=your-secret

# Server
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

## API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/analyze` | AI analysis (NDJSON stream) |
| `POST` | `/api/auto-edit` | Full AI auto-edit (video in, video out) |
| `POST` | `/api/render` | Render an EditPlan |
| `POST` | `/api/trim` | Trim video (`?in=5&out=15`) |
| `POST` | `/api/overlay` | Burn text overlays |
| `POST` | `/api/adjust-audio` | Adjust volume (`?volume=150`) |
| `POST` | `/api/merge` | Merge multiple videos |

```bash
# AI auto-edit
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
| Backend | Express.js, ffmpeg/ffprobe |
| AI | Multi-agent pipeline (6 agents), Ollama / Claude API, RAG knowledge base |
| Persistence | IndexedDB (client), filesystem (server) |

## Project Structure

```
apps/web/        Frontend (React + Tailwind + shadcn/ui)
apps/api/        Backend (Express + ffmpeg + AI pipeline)
packages/core/   Shared TypeScript types
```

<details>
<summary>Multi-Agent Pipeline</summary>

```
Frames → CUT → STRUCTURE → CONTINUITY → TRANSITION → CONSTRAINTS → QUALITY GUARD → EditPlan
```

Each agent uses the LLM with a domain-specific prompt and RAG context. Falls back to deterministic logic when the LLM is unavailable.
</details>

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
