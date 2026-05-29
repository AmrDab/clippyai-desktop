/**
 * scripts/test-lumiere-scorer.js — behavioral unit tests for the v0.20.0
 * "Lumiere" probabilistic proactive scorer (shadow-mode core).
 *
 * Covers the four properties the milestone's governing principle demands:
 *   (1) score MONOTONICITY — adding evidence never lowers p;
 *   (2) THRESHOLD BOUNDARY — decide() fires iff p > threshold*cost, kill switch;
 *   (3) interruption-cost SUPPRESSION — a high-cost moment suppresses a fire
 *       that would otherwise happen (the P0 guard: stay quiet when busy);
 *   (4) event-buffer EVICTION — UserEventBus drops by age and by count cap.
 *
 * The scorer / cost / event-bus / seen-context modules are pure TypeScript
 * with ZERO Electron imports, so we transpile them with esbuild and evaluate
 * in a sandbox whose `require` is the real Node require (no stubs needed).
 *
 * Run: node scripts/test-lumiere-scorer.js
 * Exits non-zero on any failure.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const esbuild = require('esbuild');

const out = (s) => process.stdout.write(s + '\n');
let passed = 0;
let failed = 0;
const failures = [];
function pass(name) { out(`  \x1b[32m[PASS]\x1b[0m ${name}`); passed++; }
function fail(name, reason) { out(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}`); failed++; failures.push(`${name}: ${reason}`); }
function header(name) { out(`\n=== ${name} ===`); }
function assert(cond, name, reason) { if (cond) pass(name); else fail(name, reason || 'assertion failed'); }

const ROOT = path.resolve(__dirname, '..');
const PROACTIVE = path.join(ROOT, 'src', 'main', 'proactive');

/** Transpile a pure TS module and eval it in a sandbox; return its exports. */
function loadModule(tsPath) {
  const src = fs.readFileSync(tsPath, 'utf8');
  const js = esbuild.transformSync(src, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18',
  }).code;
  const m = new Module(tsPath, module);
  m.filename = tsPath;
  m.paths = Module._nodeModulePaths(path.dirname(tsPath));
  const sandbox = {
    module: m,
    exports: m.exports,
    require: (id) => m.require(id),
    console,
    process,
    Date,
    Math,
    Object,
    Array,
    Number,
    Set,
    Map,
  };
  vm.runInNewContext(js, sandbox, { filename: tsPath });
  return m.exports;
}

const scorerMod = loadModule(path.join(PROACTIVE, 'scorer.ts'));
const costMod = loadModule(path.join(PROACTIVE, 'interruption-cost.ts'));
const eventsMod = loadModule(path.join(PROACTIVE, 'user-events.ts'));
const seenMod = loadModule(path.join(PROACTIVE, 'seen-context.ts'));

const { ProactiveProbabilityScorer, DEFAULT_THRESHOLD, resolveThreshold } = scorerMod;
const { currentInterruptionCost, MIN_COST, MAX_COST } = costMod;
const { UserEventBus, summarize } = eventsMod;
const { SeenContext } = seenMod;

const noSignal = () => ({ stuckPause: false, refocusCount: 0, errorState: false, novelContext: false, rulePrior: 0 });

// ════════════════════════════════════════════════════════════════════════
// 1. Score monotonicity + range
// ════════════════════════════════════════════════════════════════════════
header('Lumiere — score monotonicity & range');
{
  const s = new ProactiveProbabilityScorer();

  const base = s.score(noSignal());
  assert(base === 0, 'no-signal score is exactly 0', `got ${base}`);

  // Every single signal turned on raises p above 0.
  assert(s.score({ ...noSignal(), stuckPause: true }) > base, 'stuckPause raises p');
  assert(s.score({ ...noSignal(), errorState: true }) > base, 'errorState raises p');
  assert(s.score({ ...noSignal(), novelContext: true }) > base, 'novelContext raises p');
  assert(s.score({ ...noSignal(), rulePrior: 0.4 }) > base, 'rulePrior raises p');
  assert(s.score({ ...noSignal(), refocusCount: 3 }) > base, 'refocus≥3 raises p');

  // Refocus below trigger contributes nothing (memo: only counts at ≥3).
  assert(s.score({ ...noSignal(), refocusCount: 2 }) === 0, 'refocus<3 contributes 0');

  // Monotone: adding a signal to any feature set never decreases p.
  let prev = s.score(noSignal());
  const cumulative = [
    { errorState: true },
    { novelContext: true },
    { rulePrior: 0.4 },
    { refocusCount: 4 },
    { stuckPause: true },
  ];
  let acc = noSignal();
  let monotone = true;
  for (const add of cumulative) {
    acc = { ...acc, ...add };
    const p = s.score(acc);
    if (p < prev - 1e-9) { monotone = false; break; }
    prev = p;
  }
  assert(monotone, 'p is monotonic non-decreasing as evidence accrues');

  // All-on stays clamped in [0,1].
  const allOn = s.score({ stuckPause: true, refocusCount: 99, errorState: true, novelContext: true, rulePrior: 1 });
  assert(allOn >= 0 && allOn <= 1, 'p clamped to [0,1]', `got ${allOn}`);

  // rulePrior is clamped: a >1 prior cannot exceed the rulePrior weight cap.
  const clampedPrior = s.score({ ...noSignal(), rulePrior: 5 });
  const maxPrior = s.score({ ...noSignal(), rulePrior: 1 });
  assert(Math.abs(clampedPrior - maxPrior) < 1e-9, 'rulePrior input clamped to ≤1');
}

// ════════════════════════════════════════════════════════════════════════
// 2. Threshold boundary + kill switch
// ════════════════════════════════════════════════════════════════════════
header('Lumiere — threshold boundary & kill switch');
{
  const s = new ProactiveProbabilityScorer();

  // Construct a high-p state and a neutral cost (1.0).
  const strong = { stuckPause: true, refocusCount: 4, errorState: true, novelContext: true, rulePrior: 0.4 };
  const pStrong = s.score(strong);
  assert(pStrong > 0.55, 'strong state exceeds default threshold', `p=${pStrong}`);

  const fire = s.decide(strong, 1.0, 0.55);
  assert(fire.wouldFire === true, 'strong state + cost 1.0 fires at 0.55');

  // A threshold just above p suppresses. Use a NON-saturated mid state so the
  // threshold can actually sit above p (a clamped p=1.0 can't be exceeded by
  // any threshold ≤ 0.8).
  const midState = { ...noSignal(), errorState: true, novelContext: true }; // p = 0.40
  const pMidState = s.score(midState);
  assert(pMidState > 0.3 && pMidState < 0.8, 'mid state p is in tunable range', `p=${pMidState}`);
  const justAbove = s.decide(midState, 1.0, pMidState + 0.05);
  assert(justAbove.wouldFire === false, 'threshold just above p suppresses');
  const justBelow = s.decide(midState, 1.0, pMidState - 0.05);
  assert(justBelow.wouldFire === true, 'threshold just below p fires');

  // Strict inequality: p exactly at threshold does NOT fire (p > threshold).
  const weak = { ...noSignal(), errorState: true }; // p = 0.30 exactly
  const exact = s.decide(weak, 1.0, s.score(weak));
  assert(exact.wouldFire === false, 'p exactly == threshold does not fire (strict >)');

  // Kill switch: threshold 0 → always allowed (collapse to legacy behavior).
  const killed = s.decide(noSignal(), 1.0, 0);
  assert(killed.wouldFire === true, 'threshold 0 is kill switch (always allowed)');

  // resolveThreshold policy.
  assert(resolveThreshold(undefined) === DEFAULT_THRESHOLD, 'resolveThreshold(undefined)=default');
  assert(resolveThreshold(0) === 0, 'resolveThreshold(0)=0 (kill switch preserved)');
  assert(resolveThreshold(0.1) === 0.3, 'resolveThreshold clamps low to 0.3');
  assert(resolveThreshold(0.99) === 0.8, 'resolveThreshold clamps high to 0.8');
  assert(resolveThreshold(0.55) === 0.55, 'resolveThreshold passes in-range value');
}

// ════════════════════════════════════════════════════════════════════════
// 3. Interruption-cost suppression (the P0 guard)
// ════════════════════════════════════════════════════════════════════════
header('Lumiere — interruption-cost suppression');
{
  const s = new ProactiveProbabilityScorer();
  const strong = { stuckPause: true, refocusCount: 4, errorState: true, novelContext: true, rulePrior: 0.4 };

  // Idle on a normal app: cheap to interrupt → low cost → fires.
  const cheap = currentInterruptionCost({ app: 'Notes', idleSec: 40 });
  assert(cheap < 1.0, 'idle on stable app yields cost < 1.0', `cost=${cheap}`);
  assert(s.decide(strong, cheap, 0.55).wouldFire === true, 'fires in a cheap (idle) moment');

  // Same strong state, but the user is in a video call typing: expensive →
  // the SAME p must be suppressed. This is the "stay quiet when busy" P0 guard.
  // Windows process name (get-foreground-window.ps1 emits the EXE base name).
  const busy = currentInterruptionCost({ app: 'Zoom', idleSec: 0, recentTypingMs: 1000 });
  assert(busy > cheap, 'video-call+typing cost exceeds idle cost', `busy=${busy} cheap=${cheap}`);
  const busyVerdict = s.decide(strong, busy, 0.55);
  assert(busyVerdict.effectiveThreshold > 0.55, 'high cost raises effective threshold');

  // Construct a case where cost flips the decision: a mid-p state that fires
  // when cheap but is suppressed when expensive.
  const mid = { ...noSignal(), errorState: true, novelContext: true, rulePrior: 0.4 }; // p≈0.62
  const pMid = s.score(mid);
  const cheapMid = s.decide(mid, 1.0, 0.55);
  // POWERPNT = PowerPoint slideshow (Windows process name).
  const dndCost = currentInterruptionCost({ app: 'POWERPNT', idleSec: 0, doNotDisturb: true });
  const expensiveMid = s.decide(mid, dndCost, 0.55);
  assert(cheapMid.wouldFire === true, `mid-p (${pMid.toFixed(2)}) fires at cost 1.0`);
  assert(expensiveMid.wouldFire === false, 'same mid-p SUPPRESSED under DND+PowerPoint cost (P0 guard)');

  // Cost stays clamped.
  assert(dndCost <= MAX_COST + 1e-9 && cheap >= MIN_COST - 1e-9, 'cost clamped to [0.2,1.5]', `dnd=${dndCost} cheap=${cheap}`);
}

// ════════════════════════════════════════════════════════════════════════
// 4. Event-buffer eviction (age + count)
// ════════════════════════════════════════════════════════════════════════
header('Lumiere — UserEventBus eviction');
{
  // Age eviction: window 1000ms.
  const bus = new UserEventBus({ windowMs: 1000, maxEvents: 100 });
  bus.record({ type: 'focus', ts: 0, app: 'A' }, 0);
  bus.record({ type: 'focus', ts: 500, app: 'B' }, 500);
  assert(bus.snapshot(900).length === 2, 'both events retained within window');
  // At t=1600, the t=0 event (age 1600 > 1000) is evicted; t=500 (age 1100) too.
  assert(bus.snapshot(1600).length === 0, 'events older than window evicted by age');

  // Count eviction: cap 3.
  const capped = new UserEventBus({ windowMs: 1e9, maxEvents: 3 });
  for (let i = 0; i < 10; i++) capped.record({ type: 'focus', ts: i, app: `app${i}` }, i + 1);
  const snap = capped.snapshot(100);
  assert(snap.length === 3, 'count cap enforced', `got ${snap.length}`);
  assert(snap[0].app === 'app7' && snap[2].app === 'app9', 'oldest evicted, newest kept', JSON.stringify(snap.map((e) => e.app)));

  // observe() synthesizes transition events from snapshots.
  const obs = new UserEventBus({ windowMs: 1e9, maxEvents: 100 });
  obs.observe({ app: 'Code', windowTitle: 'a.ts', idleSec: 0 }, 1000);    // first sample, no diff
  obs.observe({ app: 'Code', windowTitle: 'a.ts', idleSec: 0 }, 2000);    // no change
  obs.observe({ app: 'Slack', windowTitle: 'general', idleSec: 0 }, 3000); // focus change
  obs.observe({ app: 'Slack', windowTitle: 'general', idleSec: 20 }, 4000); // active→idle
  obs.observe({ app: 'Slack', windowTitle: 'general', idleSec: 0 }, 5000);  // idle→active
  const evs = obs.snapshot(6000).map((e) => e.type);
  assert(evs.filter((t) => t === 'focus').length === 1, 'observe() emits exactly one focus event', JSON.stringify(evs));
  assert(evs.includes('idle') && evs.includes('active'), 'observe() emits idle and active transitions', JSON.stringify(evs));

  // summarize() refocus oscillation.
  const flap = new UserEventBus({ windowMs: 1e9, maxEvents: 100 });
  // Code↔Chrome flapping: 4 Code focuses within 60s.
  for (let i = 0; i < 4; i++) {
    flap.record({ type: 'focus', ts: i * 1000, app: 'Code' }, i * 1000);
    flap.record({ type: 'focus', ts: i * 1000 + 500, app: 'Chrome' }, i * 1000 + 500);
  }
  const sum = summarize(flap.snapshot(10_000), 10_000, 60_000);
  assert(sum.maxRefocusOfSameApp === 4, 'summarize counts max refocus of same app', `got ${sum.maxRefocusOfSameApp}`);
}

// ════════════════════════════════════════════════════════════════════════
// 5. SeenContext novelty + LRU
// ════════════════════════════════════════════════════════════════════════
header('Lumiere — SeenContext novelty & LRU');
{
  const seen = new SeenContext({}, 2);
  assert(seen.isNovel('Code', 'main.ts') === true, 'unseen context is novel');
  const r1 = seen.record('Code', 'main.ts', 1000);
  assert(r1.novel === true, 'first record reports novel');
  assert(seen.isNovel('Code', 'main.ts') === false, 'seen context no longer novel');
  const r2 = seen.record('Code', 'main.ts', 2000);
  assert(r2.novel === false && r2.entry.seenCount === 2, 'second record increments count');

  // Title normalization collapses numeric differences.
  assert(seen.isNovel('Slack', 'general (3)') === seen.isNovel('Slack', 'general (7)'), 'numeric titles normalize together');

  // LRU eviction at cap 2.
  seen.record('B', 'x', 3000);
  seen.record('C', 'y', 4000); // over cap → least-recently-seen ('Code main.ts' lastSeen 2000) evicted
  assert(seen.size === 2, 'LRU cap enforced', `size=${seen.size}`);
  assert(seen.isNovel('Code', 'main.ts') === true, 'least-recently-seen entry evicted by LRU');
}

// ════════════════════════════════════════════════════════════════════════
out('');
if (failed > 0) {
  out(`\x1b[31m${failed} FAILED\x1b[0m, ${passed} passed`);
  failures.forEach((f) => out('  - ' + f));
  process.exit(1);
} else {
  out(`\x1b[32mAll ${passed} Lumiere tests passed\x1b[0m`);
  process.exit(0);
}
