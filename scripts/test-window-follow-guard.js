/**
 * scripts/test-window-follow-guard.js — behavioral regression guard for the
 * window-follow "storm guard" (launch blocker #1).
 *
 * Background: a NaN/Infinity reaching Electron's native win.setBounds() throws
 * synchronously ("conversion failure from …"). Inside the 1Hz floating tick()
 * in window-follow.ts that throw became a process-level unhandledRejection that
 * flooded clippy-2026-05-27.log for ~29h / 18,544 lines. The structural fix
 * extracts the finite-rect check into the pure, exported safeBoundsRect():
 * it rounds the candidate rect and returns null if ANY component is non-finite,
 * so tick() can skip setBounds rather than poison the loop.
 *
 * This test proves safeBoundsRect's contract directly:
 *   - any non-finite target component (NaN / Infinity / undefined / null target)
 *     → null  (so the caller skips setBounds — the storm can't recur)
 *   - non-finite window size → null
 *   - finite input → a rounded {x,y,width,height} rect
 *
 * window-follow.ts imports `electron`, `./logger`, and `./mac-bridge-native`
 * at module top — all of which throw outside an Electron main process — so we
 * TRANSFORM the single file with esbuild (no bundling) and run it in a sandbox
 * whose `require` is a shim feeding inert stubs for the externals. Transform
 * (vs bundle) is the right tool here: it leaves every import as a literal
 * `require("…")` we intercept, so esbuild never tries to load transitive
 * `.node` (keytar) / `.tpl?raw` (profile-template) assets it has no loader for.
 * safeBoundsRect itself is pure (Math.round + Number.isFinite) so it runs
 * against the genuine shipped code.
 *
 * Run: node scripts/test-window-follow-guard.js
 * Exits non-zero on any failure (CI/git-hook safe).
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WINDOW_FOLLOW = path.join(ROOT, 'src', 'main', 'window-follow.ts');

let passed = 0;
let failed = 0;
const failures = [];
function pass(name) { console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); passed++; }
function fail(name, reason) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}`); failed++; failures.push(`${name}: ${reason}`); }
function assert(cond, name, reason) { if (cond) pass(name); else fail(name, reason || 'assertion failed'); }

console.log('=== window-follow storm guard (safeBoundsRect, behavioral) ===');

let bundle;
try {
  const src = fs.readFileSync(WINDOW_FOLLOW, 'utf8');
  bundle = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' }).code;
} catch (e) {
  fail('transform window-follow.ts', (e && e.message ? e.message : String(e)).substring(0, 400));
  finish();
}

// Inert stub for the externalized modules — same shape as test-tooltiers-memo.js.
function inert() {
  const ctor = function () { return inert(); };
  const target = function () { return inert(); };
  target.default = ctor;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'default') return ctor;
      if (prop === Symbol.toPrimitive || prop === Symbol.iterator || prop === 'then') return undefined;
      return inert();
    },
    apply() { return inert(); },
    construct() { return inert(); },
  });
}

const REAL_BUILTINS = new Set(['crypto', 'fs', 'path', 'os', 'util', 'events', 'stream']);

let mod;
try {
  const wrapped = `(function(module, exports, require){\n${bundle}\n})`;
  // eslint-disable-next-line no-eval
  const factory = eval(wrapped);
  const moduleObj = { exports: {} };
  const shimRequire = (req) => (REAL_BUILTINS.has(req) ? require(req) : inert());
  Object.assign(shimRequire, require);
  factory(moduleObj, moduleObj.exports, shimRequire);
  mod = moduleObj.exports;
} catch (e) {
  fail('load bundle', (e && e.stack ? e.stack : String(e)).substring(0, 600));
  finish();
}

const safeBoundsRect = mod && mod.safeBoundsRect;
if (typeof safeBoundsRect !== 'function') {
  fail('export safeBoundsRect', `window-follow.ts must export safeBoundsRect (got ${typeof safeBoundsRect})`);
  finish();
}

// ── Non-finite inputs → null (so tick() skips setBounds; the storm can't recur)
assert(safeBoundsRect({ x: NaN, y: 10 }, 140, 120) === null, 'NaN target.x → null');
assert(safeBoundsRect({ x: 10, y: NaN }, 140, 120) === null, 'NaN target.y → null');
assert(safeBoundsRect({ x: Infinity, y: 10 }, 140, 120) === null, 'Infinity target.x → null');
assert(safeBoundsRect({ x: 10, y: -Infinity }, 140, 120) === null, '-Infinity target.y → null');
assert(safeBoundsRect({ x: undefined, y: 10 }, 140, 120) === null, 'undefined target.x → null');
assert(safeBoundsRect({ x: 10, y: 10 }, NaN, 120) === null, 'NaN window width → null');
assert(safeBoundsRect({ x: 10, y: 10 }, 140, Infinity) === null, 'Infinity window height → null');
assert(safeBoundsRect(null, 140, 120) === null, 'null target → null');
assert(safeBoundsRect(undefined, 140, 120) === null, 'undefined target → null');

// ── Finite input → rounded {x,y,width,height}
const r = safeBoundsRect({ x: 100.4, y: 200.6 }, 140.2, 119.9);
assert(
  r !== null && r.x === 100 && r.y === 201 && r.width === 140 && r.height === 120,
  'finite input → rounded rect',
  `got ${JSON.stringify(r)}`,
);

// ── Negative finite coords are valid (multi-monitor: displays left of primary)
const neg = safeBoundsRect({ x: -1920, y: -10 }, 140, 120);
assert(
  neg !== null && neg.x === -1920 && neg.y === -10,
  'negative finite coords pass through (multi-monitor left display)',
  `got ${JSON.stringify(neg)}`,
);

// ── Zero is finite → valid rect (boundary)
const zero = safeBoundsRect({ x: 0, y: 0 }, 0, 0);
assert(
  zero !== null && zero.x === 0 && zero.y === 0 && zero.width === 0 && zero.height === 0,
  'zero is finite → rect returned',
  `got ${JSON.stringify(zero)}`,
);

finish();

function finish() {
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}
