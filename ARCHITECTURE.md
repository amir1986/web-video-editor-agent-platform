Architecture (v0.1)

Modules
- apps/web
  - UI: Assets panel, Preview player, Timeline (In/Out), Export dialog, Agent panel
  - Local storage: IndexedDB for Project state + Events log
  - Calls only apps/api endpoints

- apps/api (Gateway)
  - Proxies /api/ai/suggest to local Ollama (OpenAI-compatible)
  - Loads prompts/policy from /prompts
  - Validates AI output with JSON Schema
  - Enforces a single-session mutation queue (no concurrent project mutations)

- packages/core
  - Project state model (TypeScript types)
  - Timeline operations ("ops") applied deterministically
  - Skill registry and executor

Data contracts
- ProjectState: clips[], inOut markers, titles[], exports[]
- TimelineOp: a small set of mutation ops (setInOut, addTitle, etc)
- EditPlan: JSON schema versioned. LLM returns EditPlan only.
- Executor: EditPlan -> list of TimelineOp -> apply ops -> new ProjectState

Learning loop (v0.1)
- Events are local JSONL.
- Evaluation harness uses synthetic metadata scenarios (no copyrighted media).
- Nightly improvements may change only:
  - prompts/ai/system.md
  - prompts/ai/policy.json
  - prompts/ai/user_template.md
  - docs/ai/*
- Nightly changes must be gated by evaluation (no regressions).
