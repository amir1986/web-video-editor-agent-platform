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

## Architecture Conventions

### Body Parsing Convention

The API uses three body parsing strategies, each for a specific use case:

| Strategy | When to use | Endpoints |
|----------|------------|-----------|
| `express.json()` | JSON-only payloads (metadata, frames as base64) | `/api/analyze`, `/api/approve-delivery`, `/api/ollama/chat` |
| `express.raw({ type: "*/*", limit: "2gb" })` | Single video binary with metadata in query params | `/api/trim`, `/api/auto-edit`, `/api/render`, `/api/overlay`, `/api/adjust-audio` |
| `multer.array()` | Multiple file uploads | `/api/merge` |

**Rule:** For endpoints that accept raw video, pass structured data via **query params** (preferred) or `X-*` headers (legacy). Never put JSON in the body alongside raw binary.

### Progress Event Convention

All progress events use the standardized shape `{ type, agent, message, timestamp }` across NDJSON, SSE, and WebSocket transports.

### Shared Modules

- `apps/api/src/shared/media-utils.js` — ffmpeg/ffprobe wrappers, temp file helpers, WSL path conversion
- `apps/api/src/shared/auto-edit-pipeline.js` — core auto-edit processing (used by both HTTP routes and bot channels directly)
- `packages/core/index.ts` — shared TypeScript types (imported by `apps/web`)

## Architecture Review

Review the entire project and find architectural inconsistencies in the microservices communication.

## Workflow Checklist

Before pushing or opening a PR, run these in order:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run test`
4. `npm run test:e2e`
5. `npm run check-deps`
