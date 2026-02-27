#!/usr/bin/env node

/**
 * Dependency Health Check Script
 *
 * Checks all workspace packages for:
 * 1. Deprecated packages (npm deprecation warnings)
 * 2. Known vulnerable packages (npm audit)
 * 3. Packages on a blocklist of known-deprecated libraries
 *
 * Exit codes:
 *   0 = all clear
 *   1 = deprecated or vulnerable packages found
 *
 * Usage:
 *   node scripts/check-deps.js          # full check
 *   node scripts/check-deps.js --audit  # also run npm audit
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Known deprecated / problematic packages ────────────────────────────────
// Add packages here that should NEVER be installed. This list is the
// single source of truth for the entire monorepo.
const BLOCKLIST = {
  'request':          'Deprecated since 2020. Use undici (Node 18+) or axios.',
  'request-promise':  'Deprecated (wraps request). Use undici or axios.',
  'request-promise-native': 'Deprecated (wraps request). Use undici or axios.',
  'querystring':      'Deprecated Node.js built-in. Use URLSearchParams.',
  'inflight':         'Deprecated, memory leak. Use lru-cache for coalescing.',
  'fstream':          'Deprecated since 2016. Use fs/promises + tar@7.',
  'uuid':             'Only v1–v3 are deprecated. Ensure >= 9.x.',
  'har-validator':    'Deprecated. Use har-schema directly.',
  'osenv':            'Deprecated. Use os.homedir() / os.tmpdir().',
  'node-uuid':        'Renamed to uuid. Use uuid >= 9.x.',
  'nomnom':           'Deprecated. Use commander or yargs.',
  'tough-cookie':     'Versions < 5 have prototype pollution CVE.',
};

// Packages where only OLD versions are deprecated — flag if below threshold.
const VERSION_FLOOR = {
  'rimraf':           { min: '4.0.0', note: 'Versions < 4 are deprecated.' },
  'glob':             { min: '9.0.0', note: 'Versions < 9 have security issues.' },
  'mkdirp':           { min: '2.0.0', note: 'Versions < 2 are deprecated.' },
  'fluent-ffmpeg':    { min: '3.0.0', note: 'Version 2.x is unmaintained since 2021.' },
};

// ─── Known transitive exceptions ─────────────────────────────────────────────
// These deprecated packages come from dependencies we don't control.
// They are logged as WARNINGS but do NOT fail the build.
// Two mechanisms:
//   1. TRANSITIVE_EXCEPTIONS: specific package names → always treated as warning.
//   2. OPTIONAL_DEP_ROOTS: if a deprecated/outdated package's dependency path
//      goes through one of these optional dependencies, it's a warning.
const TRANSITIVE_EXCEPTIONS = {
  'request':              'Transitive via matrix-bot-sdk → request-promise → request.',
  'request-promise':      'Transitive via matrix-bot-sdk (optional dep).',
  'request-promise-core': 'Transitive via matrix-bot-sdk → request-promise.',
  'har-validator':        'Transitive via request.',
  'tough-cookie':         'Transitive via request.',
  'uuid':                 'Transitive via various optional deps. Not a direct dep.',
  'fstream':              'Transitive via whatsapp-web.js (optional) → unzipper.',
  'inflight':             'Transitive via whatsapp-web.js (optional) → archiver → glob@7.',
};

// Optional deps whose entire transitive tree is treated as non-blocking.
// Deprecated transitive deps under these roots are logged as warnings only.
const OPTIONAL_DEP_ROOTS = new Set([
  'whatsapp-web.js',  // Brings archiver, unzipper, fstream, glob@7, rimraf@2
  'matrix-bot-sdk',   // Brings request-promise → request chain
  'botbuilder',       // Brings request-promise → request chain
]);

// ─── Known vulnerability exceptions (transitive, cannot fix upstream) ────────
// These are security issues in the request dependency chain brought in by
// matrix-bot-sdk (optional). They will be logged as warnings, not failures.
// Review this list when upgrading matrix-bot-sdk or its replacement.
const AUDIT_EXCEPTIONS = new Set([
  'request',    // SSRF — transitive via matrix-bot-sdk
  'form-data',  // Weak random boundary — transitive via request
  'qs',         // DoS via memory — transitive via request
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function semverGte(installed, minimum) {
  const parse = (v) => v.replace(/[^\d.]/g, '').split('.').map(Number);
  const a = parse(installed);
  const b = parse(minimum);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true; // equal
}

function getInstalledPackages() {
  try {
    const raw = execSync('npm ls --all --json 2>/dev/null', {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    });
    return JSON.parse(raw);
  } catch (e) {
    // npm ls exits non-zero when there are peer dep issues — still has JSON
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    return null;
  }
}

function flattenDeps(tree, results = {}, depPath = []) {
  const deps = { ...tree.dependencies };
  for (const [name, info] of Object.entries(deps)) {
    const version = info.version || 'unknown';
    const key = `${name}@${version}`;
    if (!results[key]) {
      results[key] = { name, version, paths: [] };
    }
    results[key].paths.push([...depPath, name].join(' > '));
    if (info.dependencies) {
      flattenDeps(info, results, [...depPath, name]);
    }
  }
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const runAudit = process.argv.includes('--audit');
  let issues = [];

  console.log('=== Dependency Health Check ===\n');

  // 1. Check installed packages against blocklist & version floors
  console.log('Scanning installed packages...');
  const tree = getInstalledPackages();

  if (tree) {
    const allDeps = flattenDeps(tree);

    for (const [key, { name, version, paths }] of Object.entries(allDeps)) {
      // Blocklist check
      if (BLOCKLIST[name]) {
        issues.push({
          severity: 'DEPRECATED',
          pkg: key,
          reason: BLOCKLIST[name],
          location: paths[0],
        });
      }

      // Version floor check
      if (VERSION_FLOOR[name] && version !== 'unknown') {
        const rule = VERSION_FLOOR[name];
        if (!semverGte(version, rule.min)) {
          issues.push({
            severity: 'OUTDATED',
            pkg: key,
            reason: `${rule.note} Installed: ${version}, minimum: ${rule.min}`,
            location: paths[0],
          });
        }
      }
    }
  } else {
    console.warn('  Warning: Could not parse npm ls output. Run npm install first.\n');
  }

  // 2. Check package.json files for direct blocklisted dependencies
  console.log('Checking package.json files for blocklisted direct dependencies...');
  const root = path.resolve(__dirname, '..');
  const pkgJsonPaths = [
    path.join(root, 'package.json'),
    ...getWorkspacePackageJsons(root),
  ];

  for (const pkgPath of pkgJsonPaths) {
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const relativePath = path.relative(root, pkgPath);

    for (const depType of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = pkg[depType] || {};
      for (const depName of Object.keys(deps)) {
        if (BLOCKLIST[depName]) {
          issues.push({
            severity: 'DIRECT-DEPRECATED',
            pkg: `${depName}@${deps[depName]}`,
            reason: `Listed in ${relativePath} ${depType}. ${BLOCKLIST[depName]}`,
            location: relativePath,
          });
        }
      }
    }
  }

  // 3. npm audit (optional)
  if (runAudit) {
    console.log('Running npm audit...');
    try {
      const auditRaw = execSync('npm audit --json 2>/dev/null', {
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
      });
      const audit = JSON.parse(auditRaw);
      const vulns = audit.vulnerabilities || {};
      for (const [name, info] of Object.entries(vulns)) {
        if (info.severity === 'critical' || info.severity === 'high') {
          issues.push({
            severity: `VULN-${info.severity.toUpperCase()}`,
            pkg: name,
            reason: info.via?.map(v => typeof v === 'string' ? v : v.title).join('; ') || 'See npm audit',
            location: info.fixAvailable ? `Fix: ${JSON.stringify(info.fixAvailable)}` : 'No automatic fix',
          });
        }
      }
    } catch (e) {
      if (e.stdout) {
        try {
          const audit = JSON.parse(e.stdout);
          const vulns = audit.vulnerabilities || {};
          for (const [name, info] of Object.entries(vulns)) {
            if (info.severity === 'critical' || info.severity === 'high') {
              issues.push({
                severity: `VULN-${info.severity.toUpperCase()}`,
                pkg: name,
                reason: info.via?.map(v => typeof v === 'string' ? v : v.title).join('; ') || 'See npm audit',
                location: info.fixAvailable ? `Fix available` : 'No automatic fix',
              });
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }

  // ─── Separate warnings (known transitive) from errors ────────────────────
  const seen = new Set();
  issues = issues.filter(i => {
    const key = `${i.severity}:${i.pkg}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const warnings = [];
  const errors = [];

  for (const issue of issues) {
    const pkgName = issue.pkg.split('@')[0];
    const isKnownTransitive = TRANSITIVE_EXCEPTIONS[pkgName] &&
      (issue.severity === 'DEPRECATED' || issue.severity === 'OUTDATED');
    const isKnownAuditException = AUDIT_EXCEPTIONS.has(pkgName) && issue.severity.startsWith('VULN-');
    // Check if the issue comes from an optional dep root's transitive tree
    const isFromOptionalRoot = issue.location &&
      [...OPTIONAL_DEP_ROOTS].some(root => issue.location.includes(root));

    if (isKnownTransitive || isKnownAuditException || isFromOptionalRoot) {
      if (isKnownTransitive) {
        issue.severity = 'WARN-TRANSITIVE';
        issue.reason += ` (${TRANSITIVE_EXCEPTIONS[pkgName]})`;
      } else if (isKnownAuditException) {
        issue.severity = 'WARN-VULN-KNOWN';
        issue.reason += ' (Known transitive vulnerability from optional dep chain)';
      } else {
        issue.severity = 'WARN-OPTIONAL-DEP';
        issue.reason += ` (From optional dependency tree)`;
      }
      warnings.push(issue);
    } else {
      errors.push(issue);
    }
  }

  // ─── Report ──────────────────────────────────────────────────────────────
  console.log('\n=== Results ===\n');

  if (warnings.length > 0) {
    console.log(`--- ${warnings.length} Known Transitive Warning(s) (non-blocking) ---\n`);
    for (const w of warnings) {
      console.log(`  [${w.severity}] ${w.pkg}`);
      console.log(`    ${w.reason}`);
      console.log();
    }
  }

  if (errors.length === 0) {
    console.log('No blocking issues found.\n');
    process.exit(0);
  }

  console.log(`--- ${errors.length} Blocking Issue(s) ---\n`);
  for (const issue of errors) {
    console.log(`  [${issue.severity}] ${issue.pkg}`);
    console.log(`    Reason:   ${issue.reason}`);
    console.log(`    Location: ${issue.location}`);
    console.log();
  }

  console.log(`Found ${errors.length} blocking issue(s). Please resolve before merging.\n`);
  process.exit(1);
}

function getWorkspacePackageJsons(root) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const workspaces = rootPkg.workspaces || [];
  const results = [];
  for (const ws of workspaces) {
    const wsPath = path.join(root, ws, 'package.json');
    if (fs.existsSync(wsPath)) results.push(wsPath);
  }
  return results;
}

main();
