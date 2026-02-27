# CLAUDE.md — Project Rules

## Build & Test Commands

- `npm run dev` — Start all services (API, bot, web) concurrently
- `npm run build` — Build the web UI (TypeScript + Vite)
- `npm run lint` — Run ESLint on web app
- `npm run typecheck` — Run TypeScript type checking
- `npm run test` — Run API tests
- `npm run check-deps` — Check for deprecated/vulnerable dependencies
- `npm run check-deps:full` — Full check including npm audit

## Dependency Hygiene Rules (MANDATORY)

**Every time** a new package is added or an existing one is updated, the
following rules MUST be followed:

1. **Never install deprecated packages.** Before adding any dependency, verify
   it is actively maintained. Check the npm page for deprecation warnings.

2. **Run `npm run check-deps` after any dependency change.** This script checks
   all workspace packages against a blocklist of known-deprecated libraries and
   flags outdated versions. It MUST pass with zero issues.

3. **Blocklisted packages** (never install these — see `scripts/check-deps.js`
   for the full list):
   - `request` / `request-promise` — Use `undici` (Node 18+) or `axios`
   - `inflight` — Use `lru-cache` for async coalescing
   - `fstream` — Use `fs/promises` + modern `tar`
   - `querystring` — Use `URLSearchParams` (built-in)
   - `node-uuid` — Use `uuid` >= 9.x
   - `nomnom` — Use `commander` or `yargs`

4. **Version floors** (these packages are OK but only at modern versions):
   - `rimraf` >= 4.0.0
   - `glob` >= 9.0.0
   - `mkdirp` >= 2.0.0
   - `fluent-ffmpeg` >= 3.0.0

5. **Transitive dependencies matter.** If a package you want to install brings
   in deprecated transitive deps, find an alternative that doesn't. The
   `check-deps` script catches these automatically.

6. **CI enforcement.** The `dependency-check` CI job runs on every PR and push
   to master. It will block merging if deprecated packages are detected.

7. **When fixing deprecated transitive deps:** Use npm `overrides` in the root
   `package.json` to force modern versions of transitive dependencies where
   possible.

## Code Style

- TypeScript for web app (React + Vite)
- JavaScript (ESM-compatible CommonJS) for API
- Tailwind CSS for styling
- Monorepo with npm workspaces: `apps/web`, `apps/api`, `packages/core`
