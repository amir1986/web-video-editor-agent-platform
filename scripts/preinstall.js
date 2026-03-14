#!/usr/bin/env node
// Preinstall hook — clean stale workspace node_modules.
//
// npm ci only removes the root node_modules. Stale workspace-level
// node_modules (e.g. apps/api/node_modules/undici) can survive and
// cause phantom audit findings. This script removes them so every
// install starts from a clean slate.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workspaces = ['apps/api', 'apps/web', 'packages/core'];

for (const ws of workspaces) {
  const nm = path.join(root, ws, 'node_modules');
  if (fs.existsSync(nm)) {
    fs.rmSync(nm, { recursive: true, force: true });
  }
}
