Implement:
- docs/ai/eval_scenarios/ with 20 synthetic scenarios (JSON inputs)
- Eval script that:
  - calls /api/ai/suggest for each scenario
  - validates JSON schema
  - validates constraints (range, non-overlap, min/max length, sorted)
- Add CI job to run eval

Acceptance:
- Eval runs locally and in CI
- Any failure breaks CI
