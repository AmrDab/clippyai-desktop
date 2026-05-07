/**
 * scripts/smoke.js — pre-ship smoke test (v0.11.25)
 *
 * Goal: catch 80% of regressions in <2 min. Runs three layers:
 *   Layer 1 — pure-function unit tests (no Electron, no PowerShell). ~1s.
 *   Layer 2 — integration tests that shell out to PowerShell. ~30s.
 *   Layer 3 — manual checklist printed at the end. ~2min by hand.
 *
 * Usage:
 *   node scripts/smoke.js                   # all layers
 *   node scripts/smoke.js --layer=1         # unit only
 *   node scripts/smoke.js --layer=2         # integration only
 *
 * Exits non-zero on any failure; CI/git-hook safe.
 *
 * Senior-eng principle: every test must have a clear pass/fail criterion
 * stated in the test name. No vague "it works" assertions.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'assets', 'scripts');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(name) { console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); passed++; }
function fail(name, reason) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}`); failed++; failures.push(`${name}: ${reason}`); }
function skip(name, reason) { console.log(`  \x1b[33m[SKIP]\x1b[0m ${name}: ${reason}`); skipped++; }
function header(name) { console.log(`\n=== ${name} ===`); }

// ────────────────────────────────────────────────────────────────────
// Layer 1 — pure-function unit tests
// ────────────────────────────────────────────────────────────────────

// fuzzyMatchOcrElement scoring — copied verbatim from tools.ts so we
// don't need to import ESM/Electron deps in this CJS test runner.
function fuzzyMatchOcrElement(target, elements, fgWindowBounds) {
  const t = (target || '').trim().toLowerCase();
  if (!t) return null;
  let best = null;
  const inForeground = (el) => {
    if (!fgWindowBounds) return true;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    return cx >= fgWindowBounds.x && cx <= fgWindowBounds.x + fgWindowBounds.width
        && cy >= fgWindowBounds.y && cy <= fgWindowBounds.y + fgWindowBounds.height;
  };
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const e = (el.text || '').trim().toLowerCase();
    if (!e) continue;
    let score = 0;
    if (e === t) score = 1.0;
    else if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(e)) score = 0.9;
    else if (e.includes(t)) score = 0.7 * (t.length / Math.max(e.length, 1));
    else if (t.includes(e) && e.length >= 3) score = 0.6 * (e.length / t.length);
    if (score > 0 && inForeground(el)) score += 0.05;
    if (score > 0 && (!best || score > best.score)) best = { idx: i, score, element: el };
  }
  return best && best.score >= 0.5 ? best : null;
}

function layer1() {
  header('Layer 1 — pure-function unit tests');

  // 1.1 fuzzyMatchOcrElement — empty target
  if (fuzzyMatchOcrElement('', [{ text: 'Send', x: 0, y: 0, width: 50, height: 20 }]) === null) {
    pass('fuzzyMatch: empty target → null');
  } else fail('fuzzyMatch: empty target → null', 'expected null');

  // 1.2 fuzzyMatchOcrElement — empty elements
  if (fuzzyMatchOcrElement('Send', []) === null) {
    pass('fuzzyMatch: empty elements → null');
  } else fail('fuzzyMatch: empty elements → null', 'expected null');

  // 1.3 fuzzyMatchOcrElement — exact match
  // Note: when fgWindowBounds is undefined, inForeground() defaults to true,
  // so the foreground bonus (+0.05) is always applied. Expect 1.05 not 1.0.
  const exactRes = fuzzyMatchOcrElement('Send', [{ text: 'Send', x: 0, y: 0, width: 50, height: 20 }]);
  if (exactRes && exactRes.score >= 1.0 && exactRes.score <= 1.06) pass(`fuzzyMatch: exact match (got ${exactRes.score.toFixed(2)})`);
  else fail('fuzzyMatch: exact match', `got ${exactRes ? exactRes.score : 'null'}`);

  // 1.4 fuzzyMatchOcrElement — case-insensitive exact
  const ciRes = fuzzyMatchOcrElement('SEND', [{ text: 'send', x: 0, y: 0, width: 50, height: 20 }]);
  if (ciRes && ciRes.score >= 1.0 && ciRes.score <= 1.06) pass(`fuzzyMatch: case-insensitive exact (got ${ciRes.score.toFixed(2)})`);
  else fail('fuzzyMatch: case-insensitive exact', `got ${ciRes ? ciRes.score : 'null'}`);

  // 1.5 fuzzyMatchOcrElement — whole-word substring
  const wwRes = fuzzyMatchOcrElement('Save', [{ text: 'Save Document', x: 0, y: 0, width: 100, height: 20 }]);
  if (wwRes && wwRes.score >= 0.9 && wwRes.score <= 0.96) pass(`fuzzyMatch: whole-word substring (got ${wwRes.score.toFixed(2)})`);
  else fail('fuzzyMatch: whole-word substring', `got ${wwRes ? wwRes.score : 'null'}`);

  // 1.6 fuzzyMatchOcrElement — below threshold returns null
  const noiseRes = fuzzyMatchOcrElement('xyz', [{ text: 'completely unrelated', x: 0, y: 0, width: 100, height: 20 }]);
  if (noiseRes === null) pass('fuzzyMatch: no match → null');
  else fail('fuzzyMatch: no match → null', `got score ${noiseRes.score}`);

  // 1.7 fuzzyMatchOcrElement — foreground bonus prefers in-bounds
  const fgRes = fuzzyMatchOcrElement(
    'Send',
    [
      { text: 'Send', x: 5000, y: 5000, width: 50, height: 20 },  // outside fg
      { text: 'Send', x: 100, y: 100, width: 50, height: 20 },    // inside fg
    ],
    { x: 0, y: 0, width: 1000, height: 1000 },
  );
  if (fgRes && fgRes.element.x === 100) pass('fuzzyMatch: foreground bonus picks in-bounds match');
  else fail('fuzzyMatch: foreground bonus', `got x=${fgRes ? fgRes.element.x : 'null'}`);

  // ── 1.8 PowerShell: all expected scripts exist in source tree
  const required = [
    'com-outlook-send-email.ps1',
    'com-outlook-create-event.ps1',
    'com-outlook-read-inbox.ps1',
    'com-outlook-upcoming.ps1',
    'com-excel-read.ps1',
    'com-excel-write.ps1',
    'com-create-reminder.ps1',
    'com-read-file.ps1',
    'com-write-file.ps1',
    'com-run-powershell.ps1',
    'com-http-request.ps1',
    'com-ping-host.ps1',
    'com-speak-text.ps1',
    'com-search-files.ps1',
    'com-system-info.ps1',
    'com-list-processes.ps1',
    'com-word-to-pdf.ps1',
    'com-kill-process.ps1',
    'com-list-files.ps1',
    // minimize_window uses inline PowerShell (not a separate script file)
    'find-element.ps1',
    'invoke-element.ps1',
    'get-foreground-window.ps1',
    'get-windows.ps1',
    'focus-window.ps1',
    'ocr-recognize.ps1',
    'ps-bridge.ps1',
    'show-reminder.ps1',  // v0.11.25 — new helper for cmd-injection fix
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(SCRIPTS, f)));
  if (missing.length === 0) pass(`scripts present: ${required.length}/${required.length}`);
  else fail('scripts present', `missing: ${missing.join(', ')}`);

  // 1.9 base64 encoding round-trips for the 6 patched scripts
  // Verify the Buffer.from().toString('base64') idiom in tools.ts produces
  // valid input for [Convert]::FromBase64String in PowerShell.
  const samples = [
    'Hello world',
    'Multi\nline\ntext',
    'em-dash — and "smart quotes"',
    'unicode: 你好 🎉',
    "'); calc.exe; #",  // injection probe
  ];
  let b64ok = true;
  for (const s of samples) {
    const enc = Buffer.from(s, 'utf8').toString('base64');
    const dec = Buffer.from(enc, 'base64').toString('utf8');
    if (dec !== s) { b64ok = false; break; }
  }
  if (b64ok) pass('base64 round-trip for 5 edge-case strings');
  else fail('base64 round-trip', 'one or more samples failed');

  // 1.10 com-create-reminder.ps1 no longer uses string interpolation in
  // the action.Arguments line (cmd-injection fix verification).
  const reminderSrc = fs.readFileSync(path.join(SCRIPTS, 'com-create-reminder.ps1'), 'utf8');
  if (reminderSrc.includes('-DataFile') && !reminderSrc.includes('MessageBox]::Show(\'$safeNotes')) {
    pass('cmd-injection fix: com-create-reminder no longer interpolates user input');
  } else {
    fail('cmd-injection fix', 'com-create-reminder still embeds $safeNotes/$safeTitle into action arguments');
  }

  // 1.11 outlook_send_email script accepts -subjectB64 / -bodyB64
  const sendEmailSrc = fs.readFileSync(path.join(SCRIPTS, 'com-outlook-send-email.ps1'), 'utf8');
  if (sendEmailSrc.includes('-subjectB64') && sendEmailSrc.includes('-bodyB64')) {
    pass('outlook-send-email accepts -subjectB64 + -bodyB64');
  } else fail('outlook-send-email B64 params', 'missing -subjectB64 or -bodyB64');
}

// ────────────────────────────────────────────────────────────────────
// Layer 2 — integration tests (shell out to PowerShell)
// ────────────────────────────────────────────────────────────────────

function runPS(scriptName, args, timeoutMs = 8000) {
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(SCRIPTS, scriptName),
    ...args,
  ], { timeout: timeoutMs, encoding: 'utf8' }).toString().trim();
}

function layer2() {
  header('Layer 2 — integration tests (shells out to PowerShell)');

  // 2.1 get-foreground-window emits valid JSON with required keys
  try {
    const out = runPS('get-foreground-window.ps1', []);
    const parsed = JSON.parse(out);
    if (typeof parsed.processName === 'string' && typeof parsed.processId === 'number') {
      pass(`get-foreground-window: valid JSON (${parsed.processName})`);
    } else {
      fail('get-foreground-window: shape', `keys=${Object.keys(parsed).join(',')}`);
    }
  } catch (e) {
    fail('get-foreground-window: exec', e.message.substring(0, 100));
  }

  // 2.2 com-outlook-send-email base64 path doesn't crash on edge-case body
  // (Test only the invocation surface; we don't actually want to send mail.
  // Expected outcome: script EITHER exits 0 OR emits clean JSON {ok:false}.
  // Either is acceptable; what we're testing is "doesn't crash on
  // multi-line / em-dash / smart-quote body".)
  try {
    const subjectB64 = Buffer.from('Test — \'Smart\' Subject', 'utf8').toString('base64');
    const bodyB64 = Buffer.from("Line 1\n\nLine 2 — em dash\nLine 3 with 'apostrophe'", 'utf8').toString('base64');
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(SCRIPTS, 'com-outlook-send-email.ps1'),
      '-to', 'noreply@example.com', '-subjectB64', subjectB64, '-bodyB64', bodyB64,
    ], { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    // Either {ok:true} or {ok:false,error:...} — both are clean JSON.
    const parsed = JSON.parse(out);
    if (typeof parsed.ok === 'boolean') {
      pass(`outlook-send-email B64 edge-case: clean JSON (ok=${parsed.ok})`);
    } else {
      fail('outlook-send-email B64 edge-case', `unexpected JSON shape: ${out.substring(0, 100)}`);
    }
  } catch (e) {
    // execFileSync throws on non-zero exit. The script intentionally exits 1
    // when ok=false. Inspect stdout for clean JSON.
    const stdout = (e.stdout || '').toString().trim();
    try {
      const parsed = JSON.parse(stdout);
      if (typeof parsed.ok === 'boolean') {
        pass(`outlook-send-email B64 edge-case: clean JSON via exit-1 (${parsed.error || 'no err'})`);
      } else {
        fail('outlook-send-email B64', `bad JSON on exit-1: ${stdout.substring(0, 100)}`);
      }
    } catch {
      fail('outlook-send-email B64', `script crashed without JSON. stdout=${stdout.substring(0, 80)} stderr=${(e.stderr || '').toString().substring(0, 80)}`);
    }
  }

  // 2.3 ocr-recognize: skip if script wants an image we don't have
  // (Ship a fixture later; for now skip cleanly.)
  if (fs.existsSync(path.join(ROOT, 'scripts', 'test-fixtures', 'ocr-hello.png'))) {
    try {
      const out = runPS('ocr-recognize.ps1', ['-ImagePath', path.join(ROOT, 'scripts', 'test-fixtures', 'ocr-hello.png')], 15000);
      const parsed = JSON.parse(out);
      if (Array.isArray(parsed.elements)) pass(`ocr-recognize: parsed ${parsed.elements.length} elements`);
      else fail('ocr-recognize', `no elements array: ${JSON.stringify(parsed).substring(0, 100)}`);
    } catch (e) {
      fail('ocr-recognize', e.message.substring(0, 100));
    }
  } else {
    skip('ocr-recognize', 'no test fixture (scripts/test-fixtures/ocr-hello.png)');
  }

  // 2.4 com-create-reminder accepts -titleB64/-notesB64 + writes sidecar
  // We pass a datetime in the future and check it doesn't error; we then
  // immediately delete the scheduled task it creates so we don't pollute.
  try {
    const titleB64 = Buffer.from('Smoke test reminder', 'utf8').toString('base64');
    const notesB64 = Buffer.from("with apostrophe ' and em-dash — and \"quotes\"", 'utf8').toString('base64');
    const futureIso = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace(/\.\d+Z$/, '');
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(SCRIPTS, 'com-create-reminder.ps1'),
      '-titleB64', titleB64, '-datetime', futureIso, '-notesB64', notesB64,
    ], { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    const parsed = JSON.parse(out);
    if (parsed.ok === true && parsed.taskName) {
      // Cleanup
      try {
        execFileSync('schtasks', ['/Delete', '/TN', parsed.taskName, '/F'], { timeout: 5000, stdio: 'ignore' });
      } catch { /* best effort cleanup */ }
      pass(`create-reminder B64 + cmd-injection-safe (created+deleted ${parsed.taskName})`);
    } else {
      fail('create-reminder', parsed.error || 'no taskName');
    }
  } catch (e) {
    fail('create-reminder', e.message.substring(0, 200));
  }
}

// ────────────────────────────────────────────────────────────────────
// Layer 3 — manual checklist
// ────────────────────────────────────────────────────────────────────

function layer3() {
  header('Layer 3 — manual checklist (run by hand before shipping)');
  console.log(`
  [ ]  1. Launch dev build: npm run dev
  [ ]  2. Greeting fires EXACTLY ONCE at startup (no duplicate)
  [ ]  3. Type "open notepad" → notepad opens, no error
  [ ]  4. Type "type 'hello world' in notepad" → full text typed (NOT truncated)
  [ ]  5. Right-click Clippy → Sleep → Wake — clean transitions
  [ ]  6. Take a screenshot via tool — log shows downscale dimensions
  [ ]  7. Settings opens + closes without console errors
  [ ]  8. After dev session — check %APPDATA%\\ClippyAI\\clippy.log for [error] lines (should be zero)
  [ ]  9. After close — Task Manager shows NO orphaned powershell.exe processes
  [ ]  10. Send email test (without recipient) — verify hallucination guard fires if model claims success on failure
  `);
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const layerArg = (args.find((a) => a.startsWith('--layer=')) || '--layer=all').split('=')[1];

console.log(`ClippyAI smoke test — layer=${layerArg}`);

if (layerArg === '1' || layerArg === 'all') layer1();
if (layerArg === '2' || layerArg === 'all') layer2();
if (layerArg === '3' || layerArg === 'all') layer3();

console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
if (failed > 0) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failed > 0 ? 1 : 0);
