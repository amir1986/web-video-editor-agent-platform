#!/usr/bin/env node
// Preinstall hook — intentional no-op.
//
// check-deps.js requires node_modules to already be present, so running it
// at preinstall time (before packages are installed) is meaningless.
// The full dependency health check is enforced by:
//   - `npm run check-deps`  (run manually after any dependency change)
//   - CI `dependency-check` job (runs on every PR and push to master)
