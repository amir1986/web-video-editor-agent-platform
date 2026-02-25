Implement:
- In/Out markers with draggable handles in timeline
- Store markers in ProjectState
- Create a TimelineOp: setInOut in packages/core and apply deterministically via an executor

Acceptance:
- In/Out works and persists
- Ops are applied via core executor (no ad-hoc state mutations)
