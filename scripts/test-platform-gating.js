/**
 * scripts/test-platform-gating.js — behavioral regression guard for the
 * v0.20.0 cross-platform tool gating (launch blocker #3).
 *
 * Background (May 21-23 logs): 31 of 32 OS-bridge sites still dispatched to
 * powershell.exe on macOS and ENOENT'd in 5-30ms each, yet the model still saw
 * Windows-only tools (system_info, speak_text, kill_process, zip_files, …) in
 * its catalog, picked them, failed, and apologized with Windows-flavored copy.
 * The structural fix tags Windows-only tools `platforms: ['win32']` and the
 * darwin-capable ones `['win32','darwin']`; isToolSupportedOnPlatform is the
 * single predicate both the model-catalog filter (buildToolTiers) and the
 * dispatcher gate (executeTool) consult, so the two paths can never drift.
 *
 * This test asserts the re-tagged truth table directly against the genuine
 * TOOL_META registry — not against a hand-copied list — so a future edit that
 * silently un-gates a Windows-only tool (the exact regression that shipped the
 * "GUI bot on Mac" perception) fails CI.
 *
 * tool-meta.ts is pure TypeScript with ZERO Electron imports, so we transpile
 * it with esbuild and eval it in a vm sandbox (the simple loadModule harness
 * from test-lumiere-scorer.js — no bundle/shim needed).
 *
 * Run: node scripts/test-platform-gating.js
 * Exits non-zero on any failure (CI/git-hook safe).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const esbuild = require('esbuild');

let passed = 0;
let failed = 0;
const failures = [];
function pass(name) { console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); passed++; }
function fail(name, reason) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}`); failed++; failures.push(`${name}: ${reason}`); }
function assert(cond, name, reason) { if (cond) pass(name); else fail(name, reason || 'assertion failed'); }

const ROOT = path.resolve(__dirname, '..');
const TOOL_META_TS = path.join(ROOT, 'src', 'main', 'tool-meta.ts');

/** Transpile a pure TS module and eval it in a sandbox; return its exports. */
function loadModule(tsPath) {
  const src = fs.readFileSync(tsPath, 'utf8');
  const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' }).code;
  const m = new Module(tsPath, module);
  m.filename = tsPath;
  m.paths = Module._nodeModulePaths(path.dirname(tsPath));
  const sandbox = {
    module: m, exports: m.exports, require: (id) => m.require(id),
    console, process, Date, Math, Object, Array, Number, Set, Map,
  };
  vm.runInNewContext(js, sandbox, { filename: tsPath });
  return m.exports;
}

console.log('=== platform gating truth table (isToolSupportedOnPlatform) ===');

const mod = loadModule(TOOL_META_TS);
const { isToolSupportedOnPlatform, TOOL_META } = mod;

if (typeof isToolSupportedOnPlatform !== 'function' || !TOOL_META) {
  fail('exports', 'tool-meta.ts must export isToolSupportedOnPlatform + TOOL_META');
  finish();
}

const supported = (tool, platform) => isToolSupportedOnPlatform(TOOL_META[tool], platform);

// ── On darwin: Windows-only tools must NOT be supported ──────────────────────
const WIN32_ONLY = [
  'speak_text', 'kill_process', 'list_processes', 'ping_host',
  'zip_files', 'unzip_files', 'hash_file', 'system_info', 'security_sweep',
];
for (const tool of WIN32_ONLY) {
  assert(TOOL_META[tool] !== undefined, `registry has ${tool}`, 'tool missing from TOOL_META');
  assert(supported(tool, 'darwin') === false, `${tool} NOT supported on darwin`, 'leaked into the macOS catalog');
  assert(supported(tool, 'win32') === true, `${tool} IS supported on win32`, 'win32-only tool not available on win32');
}

// ── On darwin: the cross-platform / darwin-tagged tools ARE supported ────────
const DARWIN_OK = [
  'mouse_drag', 'mouse_hover', 'mouse_scroll',
  'open_app', 'focus_window', 'minimize_window',
];
for (const tool of DARWIN_OK) {
  assert(TOOL_META[tool] !== undefined, `registry has ${tool}`, 'tool missing from TOOL_META');
  assert(supported(tool, 'darwin') === true, `${tool} IS supported on darwin`, 'cross-platform tool wrongly gated off macOS');
  assert(supported(tool, 'win32') === true, `${tool} IS supported on win32`, 'cross-platform tool wrongly gated off win32');
}

// ── A tool with no `platforms` field → supported everywhere (default) ────────
{
  // generate_qrcode (tier 1) carries no platforms field.
  assert(TOOL_META.generate_qrcode && TOOL_META.generate_qrcode.platforms === undefined,
    'generate_qrcode has no platforms field (fixture precondition)',
    `platforms=${JSON.stringify(TOOL_META.generate_qrcode && TOOL_META.generate_qrcode.platforms)}`);
  assert(supported('generate_qrcode', 'darwin') === true, 'no-platforms tool supported on darwin (default = everywhere)');
  assert(supported('generate_qrcode', 'win32') === true, 'no-platforms tool supported on win32 (default = everywhere)');
  assert(supported('generate_qrcode', 'linux') === true, 'no-platforms tool supported on linux (default = everywhere)');
}

// ── Empty platforms array is also treated as "everywhere" (defensive) ────────
assert(isToolSupportedOnPlatform({ tier: 1, cost: 'cheap', description: 'x', platforms: [] }, 'darwin') === true,
  'empty platforms array → supported everywhere');

// ── Unknown tool (undefined meta) → false ────────────────────────────────────
assert(isToolSupportedOnPlatform(TOOL_META.this_tool_does_not_exist, 'darwin') === false,
  'unknown tool (undefined meta) → false');
assert(isToolSupportedOnPlatform(undefined, 'win32') === false,
  'undefined meta → false explicitly');

finish();

function finish() {
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}
