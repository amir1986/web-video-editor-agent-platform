#!/usr/bin/env node
// Postinstall hook — remove phantom workspace-level undici copies.
//
// Some npm versions (especially on Windows) create a workspace-local
// apps/api/node_modules/undici even when the root override should hoist
// a single copy to node_modules/undici. If the workspace copy resolves
// to a vulnerable version, npm audit reports a false positive.
//
// This script removes any workspace-level undici so the hoisted
// (overridden) version is always used.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workspaces = ['apps/api', 'apps/web', 'packages/core'];

for (const ws of workspaces) {
  const wsUndici = path.join(root, ws, 'node_modules', 'undici');
  if (fs.existsSync(wsUndici)) {
    const rootUndici = path.join(root, 'node_modules', 'undici', 'package.json');
    if (fs.existsSync(rootUndici)) {
      // Only remove workspace copy if the hoisted version exists
      fs.rmSync(wsUndici, { recursive: true, force: true });
    }
  }
}
