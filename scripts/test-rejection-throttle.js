/**
 * scripts/test-rejection-throttle.js — behavioral regression guard for the
 * unhandledRejection rate-limiter (launch blocker #2).
 *
 * Background: the prior handler logged every rejection. When a tight reject
 * loop fired at 1Hz (the window-follow NaN storm) it flooded the log with
 * 18,544 lines over ~29h. The fix logs the full stack on the FIRST sighting of
 * each distinct reason, then rate-limits repeats to at most one summary per
 * minute. That bookkeeping is extracted into the pure exported recordRejection()
 * so it can be tested deterministically with an injected clock — no process,
 * no real rejections.
 *
 * Asserts the contract that keeps the storm from recurring:
 *   - first call for a key → {shouldLog:true, isFirst:true, count:0}
 *   - 100 rapid repeats within the throttle window → ZERO further logs
 *   - exactly ONE summary log fires after the window elapses (carrying the
 *     accumulated repeat count), then the window + counter reset
 *   - distinct keys are throttled independently
 *
 * index.ts imports `electron` + many main-process modules at top, all of which
 * throw outside an Electron main process, so we TRANSFORM the single file with
 * esbuild (no bundling) and run it in a sandbox whose `require` is a shim
 * feeding inert stubs. Transform (vs bundle) leaves every import as a literal
 * `require("…")` we intercept, so esbuild never tries to load transitive
 * `.node` (keytar) / `.tpl?raw` (profile-template) assets it has no loader for.
 * recordRejection itself is pure (a Map + arithmetic) so it runs against the
 * genuine shipped code.
 *
 * Run: node scripts/test-rejection-throttle.js
 * Exits non-zero on any failure (CI/git-hook safe).
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'main', 'index.ts');

let passed = 0;
let failed = 0;
const failures = [];
function pass(name) { console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); passed++; }
function fail(name, reason) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}`); failed++; failures.push(`${name}: ${reason}`); }
function assert(cond, name, reason) { if (cond) pass(name); else fail(name, reason || 'assertion failed'); }

console.log('=== unhandledRejection throttle (recordRejection, behavioral) ===');

let bundle;
try {
  const src = fs.readFileSync(INDEX, 'utf8');
  bundle = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' }).code;
} catch (e) {
  fail('transform index.ts', (e && e.message ? e.message : String(e)).substring(0, 400));
  finish();
}

// index.ts runs `app.whenReady().then(...)` and several `import('./x').then(...)`
// at module scope. The inert proxy must therefore make `.then`/`.catch`/`.finally`
// CALLABLE (returning inert again) so those top-level chains don't throw while we
// load the module purely to reach the exported recordRejection. We never `await`
// the module, so a callable `then` can't deadlock the runner.
function inert() {
  const ctor = function () { return inert(); };
  const target = function () { return inert(); };
  target.default = ctor;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'default') return ctor;
      if (prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined;
      return inert();
    },
    apply() { return inert(); },
    construct() { return inert(); },
  });
}

const REAL_BUILTINS = new Set(['crypto', 'fs', 'path', 'os', 'util', 'events', 'stream']);

let mod;
try {
  // index.ts registers process.on('unhandledRejection'/'uncaughtException') and
  // app.whenReady() at import time. The electron stub makes app.* inert, and
  // the process listeners are harmless (they only fire on real rejections,
  // which this test never triggers). We isolate by snapshotting + restoring the
  // process listeners so loading the bundle can't leak handlers into the runner.
  const before = {
    rej: process.listeners('unhandledRejection').slice(),
    exc: process.listeners('uncaughtException').slice(),
  };

  const wrapped = `(function(module, exports, require){\n${bundle}\n})`;
  // eslint-disable-next-line no-eval
  const factory = eval(wrapped);
  const moduleObj = { exports: {} };
  const shimRequire = (req) => (REAL_BUILTINS.has(req) ? require(req) : inert());
  Object.assign(shimRequire, require);
  factory(moduleObj, moduleObj.exports, shimRequire);
  mod = moduleObj.exports;

  // Remove any listeners index.ts added so they don't intercept the runner's
  // own (none expected) rejections.
  for (const l of process.listeners('unhandledRejection')) {
    if (!before.rej.includes(l)) process.removeListener('unhandledRejection', l);
  }
  for (const l of process.listeners('uncaughtException')) {
    if (!before.exc.includes(l)) process.removeListener('uncaughtException', l);
  }
} catch (e) {
  fail('load bundle', (e && e.stack ? e.stack : String(e)).substring(0, 600));
  finish();
}

const recordRejection = mod && mod.recordRejection;
if (typeof recordRejection !== 'function') {
  fail('export recordRejection', `index.ts must export recordRejection (got ${typeof recordRejection})`);
  finish();
}

const THROTTLE = 60_000;

// ── First sighting logs with stack ───────────────────────────────────────────
{
  const map = new Map();
  const d = recordRejection(map, 'conversion failure', 1000, THROTTLE);
  assert(d.shouldLog === true && d.isFirst === true, 'first call → {shouldLog:true, isFirst:true}', JSON.stringify(d));
  assert(d.count === 0, 'first call count is 0', `count=${d.count}`);
}

// ── 100 rapid repeats within the window log exactly ONCE more (after window) ──
{
  const map = new Map();
  const key = 'conversion failure from undefined or null to a value';

  // First sighting at t=0.
  const first = recordRejection(map, key, 0, THROTTLE);
  assert(first.shouldLog && first.isFirst, 'storm: first sighting logs', JSON.stringify(first));

  // 100 repeats, each ~10ms apart — all well within the 60s window.
  let logsWithinWindow = 0;
  for (let i = 1; i <= 100; i++) {
    const d = recordRejection(map, key, i * 10, THROTTLE); // t = 10..1000ms
    if (d.shouldLog) logsWithinWindow++;
  }
  assert(logsWithinWindow === 0, '100 repeats within window → 0 further logs (no flood)', `got ${logsWithinWindow}`);

  // One more repeat AFTER the throttle window elapses → exactly one summary.
  const afterWindow = recordRejection(map, key, THROTTLE + 5, THROTTLE);
  assert(afterWindow.shouldLog === true, 'first repeat past window → one summary log', JSON.stringify(afterWindow));
  assert(afterWindow.isFirst === false, 'summary log is not flagged isFirst', JSON.stringify(afterWindow));
  // 100 suppressed repeats + this one = 101 accumulated since the first log.
  assert(afterWindow.count === 101, 'summary carries accumulated repeat count', `count=${afterWindow.count}`);

  // Immediately after the summary, the counter + window reset: more repeats are
  // suppressed again until the NEXT window elapses (proves it can't double-fire).
  const justAfterSummary = recordRejection(map, key, THROTTLE + 6, THROTTLE);
  assert(justAfterSummary.shouldLog === false, 'window resets after a summary (repeats suppressed again)', JSON.stringify(justAfterSummary));
  assert(justAfterSummary.count === 1, 'repeat counter reset to start counting from the summary', `count=${justAfterSummary.count}`);
}

// ── Exactly-at-boundary fires (>= throttleMs, matching the original handler) ──
{
  const map = new Map();
  recordRejection(map, 'k', 0, THROTTLE);            // first
  recordRejection(map, 'k', 100, THROTTLE);          // suppressed repeat
  const atBoundary = recordRejection(map, 'k', THROTTLE, THROTTLE); // now - lastLoggedAt === throttleMs
  assert(atBoundary.shouldLog === true, 'elapsed exactly == throttleMs fires (>=, matches original)', JSON.stringify(atBoundary));
}

// ── Distinct keys throttle independently ─────────────────────────────────────
{
  const map = new Map();
  const a = recordRejection(map, 'errorA', 0, THROTTLE);
  const b = recordRejection(map, 'errorB', 0, THROTTLE);
  assert(a.shouldLog && a.isFirst, 'distinct key A logs on first sighting');
  assert(b.shouldLog && b.isFirst, 'distinct key B logs on first sighting (independent of A)');
  const aRepeat = recordRejection(map, 'errorA', 10, THROTTLE);
  assert(aRepeat.shouldLog === false, 'a repeat of A is throttled without affecting B');
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
