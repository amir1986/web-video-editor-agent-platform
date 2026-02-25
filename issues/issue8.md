Implement:
- A nightly script that:
  - reads latest events.jsonl if present
  - proposes small changes ONLY to:
    prompts/ai/system.md
    prompts/ai/policy.json
    prompts/ai/user_template.md
    docs/ai/*
  - runs eval
  - if eval passes: open a PR with changes
  - if eval fails: do nothing

Docs:
- Add Windows Task Scheduler instructions to run the nightly script daily

Acceptance:
- Changes are limited to allowed files
- PR is created only when eval passes
