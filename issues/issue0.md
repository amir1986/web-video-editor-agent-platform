Create a monorepo (npm workspaces) with:
- apps/web (Vite React TS)
- apps/api (Node TS gateway)
- packages/core (types + deterministic ops)
- prompts/ai (empty for now)
Add:
- MIT LICENSE
- .gitignore
- GitHub Actions CI: npm install + lint + typecheck + build

Acceptance:
- CI runs on PRs
- npm install works at repo root
- npm run lint/typecheck/build are wired at root
- Do not change SPEC.md / AGENT_RULES.md / ARCHITECTURE.md content unless required for wiring
