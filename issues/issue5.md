Implement apps/api as Gateway:
- POST /api/ai/suggest
  - Input: { clipId, durationSec, goal, currentState }
  - Calls local Ollama via OpenAI-compatible /v1/chat/completions
  - Loads prompts/policy from /prompts/ai
  - Forces JSON-only output
  - Validates response against EditPlan schema
  - Retries up to 2 times on invalid JSON/schema fail

Create:
- apps/api/src/ai/editplan.v1.schema.json (strict schema, additionalProperties=false)
- prompts/ai/system.md (JSON-only rule, constraints)
- prompts/ai/user_template.md
- prompts/ai/policy.json (low temperature, retry settings)
- docs/ai/constraints.md

In apps/web:
- "Suggest edit" button
- Apply EditPlan via deterministic core ops only

Acceptance:
- Suggest returns schema-valid JSON only
- Apply updates ProjectState deterministically
