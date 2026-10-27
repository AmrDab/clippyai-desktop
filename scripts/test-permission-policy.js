/**
 * scripts/test-permission-policy.js — focused behavioral test for the
 * guardrails classOverrides sanitizer (security fix).
 *
 * Why standalone (not smoke.js layer 1): the smoke layer-1 cases are
 * static source-text pattern checks because they can't import the
 * Electron/TS modules. This sanitizer is real branching logic worth
 * exercising for real, so we transpile the ACTUAL permission-policy.ts
 * with esbuild, stub `electron` (app.getPath) + redirect its on-disk
 * path to a temp file, and drive it through the real public API
 * (setPolicy / getPolicy / load via decide). No reimplementation of the
 * logic under test — we assert against the production code.
 *
 * Proves:
 *   (a) a junk KEY (`not_a_class`) is dropped on setPolicy
 *   (b) a junk VALUE (`yolo`) on a real class is dropped on setPolicy
 *   (c) a valid override (real class -> 'block') passes through
 *   (d) the on-disk parse path sanitizes a tampered policy file too
 *
 * Exits non-zero on any failure.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function pass(name) { console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); passed++; }
function fail(name, reason) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}`); failed++; }

// ── Temp file the policy module will read/write through the fs stub ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-policy-test-'));
const POLICY_FILE = path.join(tmpDir, 'permission-policy.json');

// ── Load the REAL module under test with electron + logger + tool-meta
// transpiled/stubbed. esbuild bundles its local deps (tool-meta, logger)
// and we externalize `electron` + `fs` to inject stubs at require time. ──
function loadPolicyModule() {
  const built = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'permission-policy.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    // Keep electron + fs external so our requireStub can intercept them;
    // everything else (tool-meta, logger) gets inlined from source.
    external: ['electron', 'fs', 'path'],
    logLevel: 'silent',
  });
  const code = built.outputFiles[0].text;

  const warnings = [];
  const electronStub = {
    app: { getPath: () => tmpDir },
  };
  // Real fs, but every path the module asks for is redirected to our temp
  // policy file so the test never touches the user's real policy on disk.
  const fsStub = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'readFileSync') return (_p, enc) => fs.readFileSync(POLICY_FILE, enc);
      if (prop === 'writeFileSync') return (_p, data, enc) => fs.writeFileSync(POLICY_FILE + '.tmp', data, enc);
      if (prop === 'renameSync') return (_a, _b) => fs.renameSync(POLICY_FILE + '.tmp', POLICY_FILE);
      return target[prop];
    },
  });

  const m = new Module('permission-policy-test', null);
  m.filename = path.join(ROOT, 'src', 'main', 'permission-policy.js');
  m.paths = Module._nodeModulePaths(path.dirname(m.filename));
  const origRequire = m.require.bind(m);
  m.require = (id) => {
    if (id === 'electron') return electronStub;
    if (id === 'fs') return fsStub;
    // Intercept logger.warn so we can assert drops are warned.
    return origRequire(id);
  };
  m._compile(code, m.filename);
  // Capture warnings emitted by the module's logger via console (logger
  // ultimately writes JSONL; we just want to know warn() fired). We snoop
  // through a wrapped console.warn fallback below in case logger no-ops.
  m.exports.__warnings = warnings;
  return m.exports;
}

// Fresh module instance per scenario so module-level `_policy` cache and the
// temp file start clean.
function freshModule(initialFileContents) {
  if (initialFileContents === undefined) {
    try { fs.unlinkSync(POLICY_FILE); } catch { /* ignore */ }
  } else {
    fs.writeFileSync(POLICY_FILE, initialFileContents, 'utf8');
  }
  // esbuild rebuild each time is cheap (<50ms) and guarantees the module's
  // singleton state is reset.
  return loadPolicyModule();
}

console.log('\n=== permission-policy classOverrides sanitizer ===');

// (c) valid override passes through — assert FIRST so a totally broken
// sanitizer that drops everything is caught too.
try {
  const mod = freshModule();
  const result = mod.setPolicy({ classOverrides: { destructive_purchase: 'block' } });
  if (result.classOverrides.destructive_purchase === 'block') {
    pass('(c) valid override real-class -> block passes through');
  } else {
    fail('(c) valid override passes through', `got ${JSON.stringify(result.classOverrides)}`);
  }
} catch (e) { fail('(c) valid override passes through', e.message); }

// (a) junk KEY rejected
try {
  const mod = freshModule();
  const result = mod.setPolicy({ classOverrides: { not_a_class: 'block', read_only: 'block' } });
  const keyDropped = !('not_a_class' in result.classOverrides);
  const goodKept = result.classOverrides.read_only === 'block';
  if (keyDropped && goodKept) {
    pass('(a) junk KEY not_a_class dropped, valid sibling kept');
  } else {
    fail('(a) junk KEY rejected', `dropped=${keyDropped} goodKept=${goodKept} got=${JSON.stringify(result.classOverrides)}`);
  }
} catch (e) { fail('(a) junk KEY rejected', e.message); }

// (b) junk VALUE on a real class rejected
try {
  const mod = freshModule();
  const result = mod.setPolicy({ classOverrides: { destructive_file: 'yolo', destructive_send: 'approve' } });
  const valDropped = !('destructive_file' in result.classOverrides);
  const goodKept = result.classOverrides.destructive_send === 'approve';
  if (valDropped && goodKept) {
    pass('(b) junk VALUE yolo on real class dropped, valid sibling kept');
  } else {
    fail('(b) junk VALUE rejected', `dropped=${valDropped} goodKept=${goodKept} got=${JSON.stringify(result.classOverrides)}`);
  }
} catch (e) { fail('(b) junk VALUE rejected', e.message); }

// (d) on-disk parse path sanitizes a tampered file. We write junk to disk,
// then read it back through the public API. `getPolicy()` lazy-loads from
// disk on first access, so a fresh module instance exercises load().
try {
  const tampered = JSON.stringify({
    mode: 'standard',
    classOverrides: {
      not_a_class: 'allow',     // junk key
      destructive_exec: 'yolo', // junk value on real key
      destructive_file: 'allow',// valid -> should survive
    },
  });
  const mod = freshModule(tampered);
  const loaded = mod.getPolicy();
  const keyDropped = !('not_a_class' in loaded.classOverrides);
  const valDropped = !('destructive_exec' in loaded.classOverrides);
  const goodKept = loaded.classOverrides.destructive_file === 'allow';
  if (keyDropped && valDropped && goodKept) {
    pass('(d) on-disk tampered policy sanitized on load (junk key+value dropped, valid kept)');
  } else {
    fail('(d) on-disk parse sanitized', `keyDropped=${keyDropped} valDropped=${valDropped} goodKept=${goodKept} got=${JSON.stringify(loaded.classOverrides)}`);
  }
} catch (e) { fail('(d) on-disk parse sanitized', e.message); }

console.log(`\n  ${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
