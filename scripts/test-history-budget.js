/**
 * scripts/test-history-budget.js — unit test for the conversation-history
 * token-budget trimmer (brain memory fix).
 *
 * Background: the brain capped history at a flat 16 messages, so Clippy forgot
 * everything beyond ~8 turns and wiped on every restart. We now trim by a
 * token budget instead. This guards the trim math against the two failure
 * modes that matter: dropping too much (amnesia) and never dropping (unbounded
 * context → cost/latency blowup).
 *
 * We transpile the REAL src/main/history-budget.ts with esbuild (zero Electron
 * deps by design) and exercise the actual exports.
 *
 * Run: node scripts/test-history-budget.js
 * Also invoked from scripts/smoke.js layer 1.
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadModule() {
  const tsPath = path.join(ROOT, 'src', 'main', 'history-budget.ts');
  const { code } = esbuild.transformSync(fs.readFileSync(tsPath, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node18',
  });
  const m = new Module(tsPath, module);
  m.filename = tsPath;
  m.paths = Module._nodeModulePaths(path.dirname(tsPath));
  m._compile(code, tsPath);
  return m.exports;
}

// A message whose text is ~`tokens*4` chars, so estimateContentTokens ≈ tokens.
const msg = (role, tokens) => ({ role, parts: [{ text: 'x'.repeat(tokens * 4) }] });

function runHistoryBudgetTests(pass, fail) {
  let mod;
  try { mod = loadModule(); } catch (e) { fail('history-budget: load failed: ' + (e && e.message)); return; }
  const { estimateContentTokens, trimToBudget } = mod;
  if (typeof trimToBudget !== 'function' || typeof estimateContentTokens !== 'function') {
    fail('history-budget: exports missing'); return;
  }
  const check = (label, got, want) => {
    if (got === want) pass(`history-budget: ${label} → ${want}`);
    else fail(`history-budget: ${label} → expected ${want}, got ${got}`);
  };

  // 1. estimate is ~chars/4 + overhead
  check('estimate ~tokens', estimateContentTokens(msg('user', 100)), 104);
  check('estimate empty', estimateContentTokens({ role: 'user', parts: [] }), 4);
  check('estimate functionCall counted', estimateContentTokens({ role: 'model', parts: [{ functionCall: { name: 'x', args: {} } }] }) > 4, true);

  // 2. under budget → nothing dropped
  {
    const h = [msg('user', 10), msg('model', 10), msg('user', 10)];
    trimToBudget(h, 20_000, 120);
    check('under budget keeps all', h.length, 3);
  }

  // 3. over TOKEN budget → oldest dropped until it fits
  {
    const h = [msg('user', 100), msg('model', 100), msg('user', 100), msg('model', 100)]; // ~416 tokens
    trimToBudget(h, 250, 120); // keep ~2 newest
    check('token-budget trims oldest', h.length, 2);
    check('token-budget keeps NEWEST', h[h.length - 1].parts[0].text.length, 400);
  }

  // 4. over MESSAGE ceiling → trimmed to ceiling even if tokens fit
  {
    const h = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'model' : 'user', 1));
    trimToBudget(h, 1_000_000, 4);
    check('message-ceiling trims to max', h.length, 4);
  }

  // 5. SAFETY: a single message larger than the budget is still kept (never empty)
  {
    const h = [msg('user', 50_000)];
    trimToBudget(h, 20_000, 120);
    check('never drops the last message', h.length, 1);
  }

  // 6. SAFETY: two messages, newest huge → keep at least the newest (length ≥ 1)
  {
    const h = [msg('user', 5), msg('model', 50_000)];
    trimToBudget(h, 20_000, 120);
    check('huge-newest keeps ≥1 and is newest', h.length >= 1 && h[h.length - 1].parts[0].text.length === 200_000, true);
  }

  // 7. realistic: 20K budget holds far more than the old 16-message cap
  {
    const h = Array.from({ length: 200 }, (_, i) => msg(i % 2 ? 'model' : 'user', 40)); // ~44 tok each
    trimToBudget(h, 20_000, 1000); // no message ceiling in play
    // ~20000/44 ≈ 454 capacity, but we only have 200 → all kept; proves >>16
    check('20K budget keeps >> old 16-cap', h.length, 200);
  }

  // 8. empty history is a no-op
  {
    const h = [];
    trimToBudget(h, 20_000, 120);
    check('empty history no-op', h.length, 0);
  }
}

module.exports = { runHistoryBudgetTests };

if (require.main === module) {
  let passed = 0, failed = 0;
  const pass = (m) => { passed++; console.log('  ✓ ' + m); };
  const fail = (m) => { failed++; console.error('  ✗ ' + m); };
  console.log('test-history-budget:');
  runHistoryBudgetTests(pass, fail);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
