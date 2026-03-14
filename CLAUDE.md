# CLAUDE.md — Project Rules

## Build & Test Commands

| Command                    | Description                                      |
|----------------------------|--------------------------------------------------|
| `npm run dev`              | Start all services (API, bot, web) concurrently  |
| `npm run build`            | Build the web UI (TypeScript + Vite)             |
| `npm run lint`             | Run ESLint on web app                            |
| `npm run typecheck`        | Run TypeScript type checking                     |
| `npm run test`             | Run API tests                                    |
| `npm run check-deps`       | Check for deprecated/vulnerable dependencies     |
| `npm run check-deps:full`  | Full check including npm audit                   |
| `npm run test:e2e`         | Run Playwright E2E tests (headless)              |
| `npm run test:e2e:headed`  | Run Playwright E2E tests (headed, see browser)   |

## Session Management

- Use `/compact` regularly during long sessions to reduce token usage and keep context sharp.
- Before starting a `/loop` (build-fix cycles, lint-fix loops), run `/compact` first to keep the context window lean and improve accuracy across iterations.
- Prefer `/compact` + `/loop` over manual repeated prompting.

## Architecture

- **Monorepo** with npm workspaces: `apps/web`, `apps/api`, `packages/core`
- **Web app**: TypeScript, React, Vite, Tailwind CSS
- **API**: JavaScript (ESM-compatible CommonJS)
- **Bot**: Runs alongside API and web via `npm run dev`

## Dependency Hygiene Rules (MANDATORY)

**Every time** a new package is added or an existing one is updated, the following rules MUST be followed:

1. **Never install deprecated packages.** Before adding any dependency, verify it is actively maintained. Check the npm page for deprecation warnings.

2. **Run `npm run check-deps` after any dependency change.** This script checks all workspace packages against a blocklist of known-deprecated libraries and flags outdated versions. It MUST pass with zero issues.

3. **Blocklisted packages** (never install these - see `scripts/check-deps.js` for the full list):

   | Deprecated                       | Use Instead                                |
   |----------------------------------|--------------------------------------------|
   | `request` / `request-promise`    | `undici` (Node 18+) or `axios`             |
   | `inflight`                       | `lru-cache` for async coalescing           |
   | `fstream`                        | `fs/promises` + modern `tar`               |
   | `querystring`                    | `URLSearchParams` (built-in)               |
   | `node-uuid`                      | `uuid` >= 9.x                              |
   | `nomnom`                         | `commander` or `yargs`                     |
   | `resolve-url`                    | Built-in `URL` / `path` APIs               |

4. **Version floors** (allowed only at modern versions):

   | Package          | Minimum Version |
   |------------------|-----------------|
   | `rimraf`         | >= 4.0.0        |
   | `glob`           | >= 9.0.0        |
   | `mkdirp`         | >= 2.0.0        |
   | `fluent-ffmpeg`  | >= 3.0.0        |

5. **Transitive dependencies matter.** If a package brings in deprecated transitive deps, find an alternative. The `check-deps` script catches these automatically.

6. **Fixing deprecated transitive deps:** Use npm `overrides` in the root `package.json` to force modern versions where possible.

7. **CI enforcement.** The `dependency-check` CI job runs on every PR and push to master. It blocks merging if deprecated packages are detected.

## Cross-Platform Script Rules

- **Never use bash/sh syntax in npm scripts.** `npm run` uses `cmd.exe` on Windows - shell-isms like `2>/dev/null`, `|| true`, `&&` chains, and `$VAR` substitution will fail.
- Use plain `node scripts/foo.js` for any logic that needs error suppression or conditional execution.
- Use `{ stdio: ['inherit', 'pipe', 'pipe'] }` in `child_process.execSync` calls instead of appending `2>/dev/null` to the command string.

## E2E Testing (Playwright)

- **Location:** `e2e/` directory with `playwright.config.ts`
- **Test fixtures:** Generated via ffmpeg in `e2e/global-setup.ts` (3 test videos + 1 non-video file)
- **Fixtures are gitignored** — regenerated automatically on first run
- **Ollama mocking:** Tests auto-detect if Ollama is running; fall back to mocks if not. Force mocks with `MOCK_OLLAMA=1`
- **Browser:** Chromium only. Install with `npx playwright install chromium`
- **Test files:** `e2e/tests/*.spec.ts` — import, playback, AI analysis, export, merge, overlays, audio, session persistence, Ollama status

### Running E2E tests

```bash
# Headless (CI)
npm run test:e2e

# Headed (see browser)
npm run test:e2e:headed

# Force mocked Ollama
MOCK_OLLAMA=1 npm run test:e2e
```

### E2E tests MUST run on every commit

E2E tests are part of the standard verification flow. Run them alongside unit tests before pushing.

## Architecture Review — Microservices Communication Inconsistencies

The following architectural inconsistencies were identified across the project's inter-service communication patterns:

### 1. Duplicated Type Definitions — `packages/core` Is Unused

- `packages/core/index.ts` defines `ProjectState`, `Clip`, `InOut`, `Title`, `Export` types.
- **Neither `apps/web` nor `apps/api` imports from `@video-editor/core`.** The web app re-declares its own `ProjectState`, `Clip`, `Segment`, `EditPlan`, `TextOverlay` interfaces directly in `App.tsx` (lines 47–70).
- The API (`apps/api`) is plain JavaScript and ignores the core types entirely.
- **Impact:** The shared package exists but serves no purpose. Type drift is already happening — the web `Clip` has `url` instead of `path`, and `ProjectState` in the web includes `editPlan`, `overlays`, `volume`, `savedAgentSummary` that don't exist in core.

### 2. Inconsistent HTTP Client Libraries

- **Bot → API** (`channels/base.js`): Uses Node's built-in `http.request` (callback-based, manual timeout handling).
- **API → Ollama** (`ai/llm-client.js`): Uses `undici.fetch` with a custom `Agent` for timeout control.
- **Web → API** (`App.tsx`): Uses browser `fetch`.
- **Web → Ollama** (`App.tsx`): Also uses browser `fetch`, but **directly from the browser**, bypassing the API entirely.
- **Impact:** No shared HTTP abstraction. Each communication path has its own error handling, retry logic, and timeout strategy.

### 3. Web App Calls Ollama Directly (Bypasses API)

- The web UI contacts Ollama at `http://localhost:11434` directly for both model listing (`/api/tags`, line 199) and AI analysis (`/v1/chat/completions`, line 420).
- The API server also contacts Ollama for the same purpose via `/api/auto-edit` and `/api/analyze`.
- **Impact:** Two separate LLM communication paths with different retry logic (API has 3-attempt exponential backoff; web has none), different model selection (API uses env vars; web uses a user-selected dropdown), and no shared rate limiting. The web path has no fallback if Ollama is slow or fails mid-request.

### 4. Three Different Streaming Protocols for Progress

- `/api/analyze`: **NDJSON** (`application/x-ndjson`) — newline-delimited JSON with `{type, agent, message, ts}`.
- `/api/auto-edit-stream`: **SSE** (`text/event-stream`) — uses `event:` and `data:` fields with `{agent, message, timestamp}`.
- WebChat channel: **WebSocket** — sends `{type: "progress", text: "..."}`.
- **Impact:** Three different protocols for the same concept (progress updates). Field naming is also inconsistent: NDJSON uses `ts`, SSE uses `timestamp`, and WebSocket uses `text` instead of `message`.

### 5. Metadata Transport Inconsistency (Headers vs. Body)

- `/api/auto-edit`: Returns metadata in **custom HTTP headers** (`X-AI-Summary`, `X-Segments-Count`, `X-Video-Width`, `X-Style-Mode`, etc.).
- `/api/render`: Receives `EditPlan` via `X-Edit-Plan` **header** (JSON squeezed into a single header line).
- `/api/overlay`: Receives overlays via `X-Overlays` **header**.
- `/api/approve-delivery`: Sends/receives `EditPlan` in the **JSON request/response body** (standard REST).
- `/api/style-profile/:userId`: Standard **JSON body** responses.
- **Impact:** Mixing metadata transport mechanisms. Headers have size limits (~8KB in most servers/proxies), which could silently truncate large `EditPlan` payloads. Standard REST practice is to use the body for structured data.

### 6. Inconsistent Input Parsing Middleware

- `/api/analyze`: Uses `express.json()` (via global middleware, 10MB limit) — receives frames as base64 in JSON body.
- `/api/trim`, `/api/auto-edit`, `/api/render`, `/api/overlay`, `/api/adjust-audio`: Uses `express.raw({ type: "*/*", limit: "2gb" })` — receives raw video binary.
- `/api/merge`: Uses `multer.array("videos", 20)` — multipart form-data.
- `/api/approve-delivery`: Uses global `express.json()` — standard JSON body.
- **Impact:** Three different body parsing strategies across the API. No documented convention for when to use which approach. The `/api/analyze` endpoint stands out by accepting frames as JSON base64 while all other video endpoints accept raw binary.

### 7. `auto-edit-stream` Cannot Deliver the Output Video

- `/api/auto-edit-stream` (line 829) renders the video, sends an SSE `complete` event, then **cleans up the temp files** in the `finally` block (line 904).
- The comment on line 897 says "client must fetch the video via a separate request" but **there is no endpoint or mechanism to retrieve the rendered file** — it's deleted before the client could fetch it.
- **Impact:** The SSE streaming endpoint is effectively broken for actually delivering the edited video.

### 8. Queue Applied Inconsistently

- `/api/auto-edit`: Wrapped in `enqueueAutoEdit()` — serialized to prevent VRAM overload.
- `/api/auto-edit-stream`: **Not queued** — runs directly, can overload VRAM if called concurrently.
- `/api/analyze`: **Not queued** — also runs the full LLM pipeline (`runEditPipeline`) without queue protection.
- **Impact:** The queue exists to protect VRAM, but two of the three AI-heavy endpoints bypass it entirely, defeating the purpose.

### 9. Duplicated Utility Functions

- `toWslPath()`, `tmpFile()`, `cleanup()` are defined independently in both `apps/api/src/index.js` (lines 53–64) and `apps/api/src/channels/base.js` (lines 25–38).
- They have slightly different implementations: `index.js` uses `va_` prefix for temp files, `base.js` uses `ch_` prefix.
- FFmpeg/FFprobe wrappers exist in both files with different function names (`ffmpeg`/`ffprobe` in index.js vs `ffmpegExec`/`ffprobeExec` in base.js).
- **Impact:** Code duplication within the same workspace. Bugs fixed in one copy may not be fixed in the other.

### 10. Bot Calls Its Own API via HTTP Loopback

- Bot channels run in the same Node.js process as the Express API (`npm run dev` starts both concurrently).
- Yet channels call `http://localhost:3001/api/auto-edit` via HTTP (base.js line 129) instead of invoking the handler function directly.
- **Impact:** Unnecessary network overhead, serialization/deserialization of potentially 2GB video buffers through HTTP. Adds latency and memory pressure (video is read into memory, then written to HTTP body, then read again by Express). A direct function call would be more efficient for in-process communication.

### 11. Authentication Not Applied to Web → Ollama Path

- The API has `authMiddleware` protecting all `/api/*` endpoints.
- The web UI's direct Ollama calls (`http://localhost:11434`) bypass authentication entirely since they don't go through the API.
- **Impact:** If `AUTH_SECRET` is set to protect the API, the AI analysis features still work unauthenticated via the direct Ollama path from the browser.

### 12. CORS Origin Duplicated and Hardcoded

- API server sets CORS: `process.env.CORS_ORIGIN || "http://localhost:5173"` (index.js line 50).
- `/api/auto-edit-stream` **manually re-sets** `Access-Control-Allow-Origin` in its `writeHead` call (line 837) instead of relying on the CORS middleware.
- The Ollama base URL `http://localhost:11434` is hardcoded in the web app (App.tsx line 33) with no env var override, unlike the API base URL which uses `VITE_API_URL`.

## Workflow Checklist

Before pushing or opening a PR, run these in order:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run test`
4. `npm run test:e2e`
5. `npm run check-deps`
