/**
 * scripts/run-tests.js — runs every scripts/test-*.js in sequence.
 * Cross-platform replacement for the old bash for-loop in `npm test`
 * (which fails under cmd.exe). Exits non-zero on the first failure.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const tests = fs.readdirSync(dir).filter((f) => /^test-.*\.js$/.test(f)).sort();

// Tests must never write to the real ~/.clippyai: some scripts bundle the real
// logger, which logs under os.homedir(). Same throwaway home as vitest.config.ts.
const testHome = path.join(require('os').tmpdir(), 'clippy-test-home');
const env = { ...process.env, HOME: testHome, USERPROFILE: testHome };

for (const t of tests) {
  console.log(`\n# scripts/${t}`);
  const r = spawnSync(process.execPath, [path.join(dir, t)], { stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status || 1);
}
