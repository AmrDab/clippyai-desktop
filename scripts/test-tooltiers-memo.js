/**
 * scripts/test-tooltiers-memo.js — behavioral TDD guard for the
 * buildToolTiers() memoization (perf/buildtooltiers-memo).
 *
 * Why a standalone runner instead of a regex check in smoke.js layer 1:
 * the rest of layer 1 inspects source text, but memoization is a *runtime*
 * property — the only honest way to prove "computed once, cached after" is
 * to actually call the function twice and observe identity + a compute
 * counter. So we transpile the real, shipped buildToolTiers out of
 * src/main/brain.ts with esbuild and execute it.
 *
 * brain.ts imports `electron` and `electron-store` at module top. Those
 * throw outside an Electron main process, so we bundle brain.ts with those
 * (and the other heavy local modules) marked external, then load the CJS
 * bundle through a require-shim that feeds harmless stubs for the externals.
 * buildToolTiers itself only depends on TOOL_META + isToolSupportedOnPlatform
 * from the pure ./tool-meta module, which IS bundled, so the function under
 * test runs against the genuine registry.
 *
 * Asserts:
 *   T1  buildToolTiers() returns a non-empty object of {tier:number, cost:string}
 *   T2  two calls return the SAME reference (identity ⇒ memoized, not rebuilt)
 *   T3  the underlying enumeration runs exactly ONCE across many calls
 *       (proven via the exported __buildToolTiersComputeCount counter)
 *   T4  the returned object is frozen — a caller cannot corrupt the shared
 *       cache for later turns
 *
 * Exits non-zero on any failure (CI/git-hook safe).
 */

const esbuild = require('esbuild');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRAIN = path.join(ROOT, 'src', 'main', 'brain.ts');

let passed = 0;
let failed = 0;
const failures = [];
function pass(name) { console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); passed++; }
function fail(name, reason) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}`); failed++; failures.push(`${name}: ${reason}`); }

console.log('=== buildToolTiers memoization (behavioral) ===');

// 1. Bundle brain.ts → CJS string. Externalize everything that has Electron
//    or native side-effects at import time; keep ./tool-meta inlined so the
//    real registry drives the function under test.
const EXTERNAL = [
  'electron', 'electron-store', 'keytar', 'crypto', 'fs', 'path', 'os',
  // local main-process modules brain.ts pulls in but buildToolTiers doesn't touch
  './tools', './cursor-vision', './user-takeover', './license', './guides',
  './memory', './logger', './contextual-suggestions', './permission-policy',
  './action-log', './undo', './mail-env', './mcp-chrome', './skill-registry',
  './window', './follow-me', './clawhub', './profile', './instincts',
  './injection-scan', './power-monitor',
];

let bundle;
try {
  const result = esbuild.buildSync({
    entryPoints: [BRAIN],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    logLevel: 'silent',
    external: EXTERNAL,
  });
  bundle = result.outputFiles[0].text;
} catch (e) {
  fail('bundle brain.ts', (e && e.message ? e.message : String(e)).substring(0, 400));
  finish();
}

// 2. Load the bundle through a require-shim. Any external local module
//    (./foo) resolves to an inert Proxy that returns no-op functions; the
//    node-builtins (fs/path/os/crypto) resolve to the real thing.
// A maximally-permissive stub for the externalized modules.
//
// esbuild wraps `require("electron-store")` as `__toESM(require(...))`, which
// builds a fresh object and *copies the required module's own enumerable
// props* onto it (incl. `default`). So a bare callable Proxy isn't enough —
// `default` must exist as an own enumerable key or `new mod.default()` blows
// up with "not a constructor". We therefore hang a real constructable inert
// function off an own `default` key, then wrap the whole thing in a Proxy so
// any *other* property access (createLogger().info(), powerMonitor.on(), …)
// also resolves to a harmless inert value. This neutralises every top-level
// side effect brain.ts runs at import time so we can reach buildToolTiers.
function inert() {
  const ctor = function () { return inert(); };
  const target = function () { return inert(); };
  // own enumerable keys that __copyProps will carry across the interop wrapper
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
  // esbuild emits `require("electron")` etc.; intercept those by compiling
  // the bundle with our shim bound as the module's require.
  const wrapped = `(function(module, exports, require){\n${bundle}\n})`;
  // eslint-disable-next-line no-eval
  const factory = eval(wrapped);
  const exportsObj = {};
  const moduleObj = { exports: exportsObj };
  const shimRequire = (req) => (REAL_BUILTINS.has(req) ? require(req) : inert());
  Object.assign(shimRequire, require);
  factory(moduleObj, exportsObj, shimRequire);
  mod = moduleObj.exports;
} catch (e) {
  fail('load bundle', (e && e.stack ? e.stack : String(e)).substring(0, 600));
  finish();
}

const buildToolTiers = mod && mod.buildToolTiers;
if (typeof buildToolTiers !== 'function') {
  fail('export buildToolTiers', `brain.ts must export buildToolTiers (got ${typeof buildToolTiers})`);
  finish();
}

// T1 — shape
const first = buildToolTiers();
const keys = first && typeof first === 'object' ? Object.keys(first) : [];
const shapeOk = keys.length > 0 && keys.every((k) => {
  const v = first[k];
  return v && typeof v.tier === 'number' && typeof v.cost === 'string';
});
if (shapeOk) pass(`shape: ${keys.length} entries, each {tier:number, cost:string}`);
else fail('shape', `keys=${keys.length}, sample=${JSON.stringify(first[keys[0]])}`);

// T2 — identity equality across calls ⇒ memoized
const second = buildToolTiers();
const third = buildToolTiers();
if (first === second && second === third) pass('memoized: repeated calls return the SAME reference');
else fail('memoized identity', 'calls returned different object references (not cached)');

// T3 — underlying enumeration ran exactly once
const counter = mod.__buildToolTiersComputeCount;
if (typeof counter !== 'function') {
  fail('compute-count probe', 'brain.ts must export __buildToolTiersComputeCount() for the memo test');
} else {
  // We have already called buildToolTiers 3× above (plus shape read). The
  // enumeration must have happened only on the first call.
  buildToolTiers(); buildToolTiers();
  const n = counter();
  if (n === 1) pass(`compute-once: enumeration ran exactly 1× across 5 calls (counter=${n})`);
  else fail('compute-once', `enumeration ran ${n}× (expected 1)`);
}

// T4 — returned object frozen ⇒ a caller cannot corrupt the shared cache
const wasFrozen = Object.isFrozen(first);
let mutationRejected = false;
try {
  first.__inject = { tier: 9, cost: 'expensive' };
  mutationRejected = !('__inject' in first); // strict mode throws; sloppy silently ignores
} catch { mutationRejected = true; }
const entryFrozen = keys.length === 0 || Object.isFrozen(first[keys[0]]);
if (wasFrozen && mutationRejected && entryFrozen) {
  pass('mutation-safe: returned map + entries are frozen (caller cannot corrupt cache)');
} else {
  fail('mutation-safe', `topFrozen=${wasFrozen}, addRejected=${mutationRejected}, entryFrozen=${entryFrozen}`);
}

finish();

function finish() {
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}
