/**
 * scripts/test-verify-after.js — unit test for shouldVerifyAfter (v0.19.1 perf)
 *
 * TDD coverage for the per-tool post-call verification gate. The brain's
 * turn loop used to run a fresh read_screen after EVERY tool in a hard-coded
 * UI_MODIFYING_TOOLS set. On macOS read_screen walks the AX tree (3-8s each),
 * so a 12-step task burned ~30s on dead verification reads. This is now
 * opt-in per tool via ToolMeta.verifyAfter ('always' | 'never' | 'on_error',
 * default 'never') and decided by the pure helper shouldVerifyAfter().
 *
 * We transpile the REAL src/main/tool-meta.ts with esbuild (no Electron deps
 * in that module) and exercise the actual exported helper — not a copy — so
 * this test guards production behavior, not a paraphrase of it.
 *
 * Run: node scripts/test-verify-after.js
 * Also invoked from scripts/smoke.js layer 1.
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadToolMeta() {
  const tsPath = path.join(ROOT, 'src', 'main', 'tool-meta.ts');
  const tsSrc = fs.readFileSync(tsPath, 'utf8');
  const { code } = esbuild.transformSync(tsSrc, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18',
  });
  const m = new Module(tsPath, module);
  m.filename = tsPath;
  m.paths = Module._nodeModulePaths(path.dirname(tsPath));
  m._compile(code, tsPath);
  return m.exports;
}

// Exported so smoke.js layer 1 can run these assertions inline and roll the
// pass/fail counts into the main smoke totals.
function runVerifyAfterTests(pass, fail) {
  let meta;
  try {
    meta = loadToolMeta();
  } catch (e) {
    fail('verifyAfter: load tool-meta.ts', e.message.substring(0, 160));
    return;
  }

  const { shouldVerifyAfter, TOOL_META } = meta;

  if (typeof shouldVerifyAfter !== 'function') {
    fail('verifyAfter: shouldVerifyAfter exported', `got ${typeof shouldVerifyAfter}`);
    return;
  }
  pass('verifyAfter: shouldVerifyAfter exported from tool-meta.ts');

  // Pick representatives by their declared verifyAfter, robust to which exact
  // tools opt in. Fall back to synthesizing if a category is empty so the
  // logic itself is always exercised.
  const alwaysTool = Object.keys(TOOL_META).find((k) => TOOL_META[k].verifyAfter === 'always');
  const onErrorTool = Object.keys(TOOL_META).find((k) => TOOL_META[k].verifyAfter === 'on_error');
  const defaultTool = Object.keys(TOOL_META).find((k) => TOOL_META[k].verifyAfter === undefined);

  // 1. an 'always' tool returns true regardless of error flag
  if (alwaysTool) {
    if (shouldVerifyAfter(alwaysTool, false) === true && shouldVerifyAfter(alwaysTool, true) === true) {
      pass(`verifyAfter: 'always' tool (${alwaysTool}) → true on success AND error`);
    } else {
      fail(`verifyAfter: 'always' tool (${alwaysTool})`, `success=${shouldVerifyAfter(alwaysTool, false)}, error=${shouldVerifyAfter(alwaysTool, true)}`);
    }
  } else {
    fail("verifyAfter: at least one 'always' tool exists", 'no tool has verifyAfter:always — the gate would never re-read');
  }

  // 2. a default/never tool returns false in both cases
  if (defaultTool) {
    if (shouldVerifyAfter(defaultTool, false) === false && shouldVerifyAfter(defaultTool, true) === false) {
      pass(`verifyAfter: default (absent) tool (${defaultTool}) → false on success AND error`);
    } else {
      fail(`verifyAfter: default tool (${defaultTool})`, `success=${shouldVerifyAfter(defaultTool, false)}, error=${shouldVerifyAfter(defaultTool, true)}`);
    }
  } else {
    fail('verifyAfter: a default (verifyAfter-absent) tool exists', 'every tool opted in — default-never semantics untested');
  }

  // 3. an explicit 'never' tool (if any author marks one) returns false
  const neverTool = Object.keys(TOOL_META).find((k) => TOOL_META[k].verifyAfter === 'never');
  if (neverTool) {
    if (shouldVerifyAfter(neverTool, false) === false && shouldVerifyAfter(neverTool, true) === false) {
      pass(`verifyAfter: explicit 'never' tool (${neverTool}) → false on success AND error`);
    } else {
      fail(`verifyAfter: explicit 'never' tool (${neverTool})`, `success=${shouldVerifyAfter(neverTool, false)}, error=${shouldVerifyAfter(neverTool, true)}`);
    }
  } else {
    // Not a failure: 'never' may simply equal "absent" in practice. Synthesize
    // by trusting the default-tool result above; nothing extra to assert.
  }

  // 4. an 'on_error' tool returns true ONLY when errored.
  // No production tool opts into 'on_error' today, so to prove the most subtle
  // branch of the helper we inject a synthetic entry into the live TOOL_META
  // object the helper reads from, assert, then remove it. This exercises the
  // real shouldVerifyAfter code path, not a paraphrase.
  let probe = onErrorTool;
  let injected = false;
  if (!probe) {
    probe = '__verifyafter_onerror_probe__';
    TOOL_META[probe] = { tier: 2, cost: 'cheap', description: 'test probe', verifyAfter: 'on_error' };
    injected = true;
  }
  try {
    if (shouldVerifyAfter(probe, true) === true && shouldVerifyAfter(probe, false) === false) {
      pass(`verifyAfter: 'on_error' tool (${probe}${injected ? ', synthetic' : ''}) → true ONLY when errored`);
    } else {
      fail(`verifyAfter: 'on_error' tool (${probe})`, `error=${shouldVerifyAfter(probe, true)}, success=${shouldVerifyAfter(probe, false)}`);
    }
  } finally {
    if (injected) delete TOOL_META[probe];
  }

  // 5. unknown tool name → false (absent meta = never), independent of branch 4
  if (shouldVerifyAfter('totally_made_up_tool', false) === false && shouldVerifyAfter('totally_made_up_tool', true) === false) {
    pass('verifyAfter: unknown tool name → false (absent meta defaults to never)');
  } else {
    fail('verifyAfter: unknown tool name → false', 'expected false for both error states');
  }
}

module.exports = { runVerifyAfterTests, loadToolMeta };

// Standalone runner — mirrors smoke.js pass/fail formatting + exit code.
if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const pass = (n) => { console.log(`  \x1b[32m[PASS]\x1b[0m ${n}`); passed++; };
  const fail = (n, r) => { console.log(`  \x1b[31m[FAIL]\x1b[0m ${n}: ${r}`); failed++; };
  console.log('\n=== shouldVerifyAfter — per-tool post-call verification gate ===');
  runVerifyAfterTests(pass, fail);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
