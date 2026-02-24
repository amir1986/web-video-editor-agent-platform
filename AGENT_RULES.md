Agent rules (must follow)

- The user writes no code. You implement everything.
- Work in small PRs. Each PR must be buildable and include clear notes.
- Do not introduce external SaaS or paid APIs. No telemetry to external endpoints.
- Do not change architecture randomly. Follow SPEC.md.
- Always add/update docs when behavior changes.
- Keep AI deterministic:
  - LLM output is JSON only
  - Validate schema
  - Apply via skills/executor
- Safety:
  - Never add secrets.
  - Never add dependencies that download arbitrary code at runtime.
- PR Definition of Done:
  - npm install
  - npm run lint
  - npm run typecheck
  - npm run build
  - Tests pass (if added)
