Project: Video Editing Agent Platform (Web, OSS)

Goal
Build an open-source, local-first web video editor powered by an agent platform (Gateway + Skills + Workflows).
The user will not write code. The agent must implement everything end-to-end.

Non-negotiable constraints
- Web app: React + TypeScript + Vite.
- Local-first: runs on localhost. No paid APIs. AI must call local Ollama only.
- AI outputs: STRICT JSON only (no markdown, no commentary), validated against a JSON Schema.
- Determinism: the LLM never edits files directly. It only returns EditPlan JSON.
- Execution: the platform executes skills deterministically and updates project state.
- Export: ffmpeg.wasm runs in a Web Worker, with progress + cancel, and the app remains responsive.
- Persist project state locally (IndexedDB).
- CI: lint + typecheck + build on every PR.

MVP v0.1 user features
1) Import a local video file (mp4/mov) in the browser (no upload).
2) Preview playback with play/pause/seek and timecode.
3) Trim via In/Out markers (draggable).
4) Export trimmed clip via ffmpeg.wasm worker with progress + cancel.
5) Project persistence in IndexedDB.

Platform v0.1 (OpenClaw-like) requirements
- apps/api acts as a Gateway:
  - /api/ai/suggest (proxy to Ollama)
  - A single "Project session" execution queue (no concurrent mutations)
- Skills are functions that apply to Project state:
  - trim.setInOut
  - titles.add
  - export.render (ffmpeg worker orchestration)

Learning v0.1 (no fine-tuning yet)
- Log user actions locally as JSONL events (accept/reject suggestion, manual edits, export success/cancel).
- Provide "Export Training Data" button (downloads JSONL).
- Provide an evaluation harness with 20 synthetic scenarios.
- Nightly improvement is allowed to change ONLY prompts/policy/config and ONLY if evaluation does not regress.
