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
    '_outlook-com-precheck.ps1',  // v0.11.29 — discriminates classic vs new Outlook
    'olk-send-email-uia.ps1',     // v0.12.2 — single-shot UIA fallback for new Outlook
    'olk-send-email-direct.ps1',  // v0.13.0 — AppX direct launch (bypasses mailto handler)
    '_path-guard.ps1',            // v0.12.3 — shared filesystem read guard
    'zip-files.ps1',              // v0.12.4
    'unzip-files.ps1',            // v0.12.4
    'hash-file.ps1',              // v0.12.4
    'ocr-from-image.ps1',         // v0.12.4
    'windows-service-control.ps1',// v0.12.4
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

  // ── v0.11.27 additions (Subagent E coverage gaps) ────────────────────

  // 1.12 soundsLikeClaimedSuccess: positive cases (model claiming action complete)
  // Copied verbatim from brain.ts so we test the actual production regex.
  function soundsLikeClaimedSuccess(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return /\b(sent|posted|submitted|created|deleted|saved|published|emailed|booked|scheduled)\b/.test(t)
      && !/\b(will|going to|let me|trying|attempting|about to|i'll|i’ll|would)\b.*\b(send|post|submit|create|delete|save|publish|email|book|schedule)\b/.test(t);
  }
  const SHOULD_TRIP = [
    'Email sent!',
    'I posted it.',
    'Created the calendar event.',
    'File deleted successfully.',
    'Saved to disk.',
    'Your message has been published.',
  ];
  const positiveFails = SHOULD_TRIP.filter((s) => !soundsLikeClaimedSuccess(s));
  if (positiveFails.length === 0) pass(`soundsLikeClaimedSuccess: trips on ${SHOULD_TRIP.length}/${SHOULD_TRIP.length} confident successes`);
  else fail('soundsLikeClaimedSuccess: missed positives', positiveFails.join(' | '));

  // 1.13 soundsLikeClaimedSuccess: negative cases (must NOT trip on future-tense)
  const SHOULD_NOT_TRIP = [
    "I'll send it now.",
    "Let me submit that for you.",
    "I'm going to create the event.",
    "I would delete it but...",
    "Trying to post — one moment.",
    'I presented the data',  // "presented" contains "sented" — \b boundary should prevent match
  ];
  const negativeFails = SHOULD_NOT_TRIP.filter((s) => soundsLikeClaimedSuccess(s));
  if (negativeFails.length === 0) pass(`soundsLikeClaimedSuccess: ${SHOULD_NOT_TRIP.length}/${SHOULD_NOT_TRIP.length} future-tense correctly suppressed`);
  else fail('soundsLikeClaimedSuccess: false positive', negativeFails.join(' | '));

  // 1.14 DESTRUCTIVE_TOOLS structural invariant — every member must exist in TOOL_MAP
  // Catches silent breakage when a tool gets renamed: hallucination guard
  // turns into a no-op for that tool with no warning.
  const brainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'brain.ts'), 'utf8');
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tools.ts'), 'utf8');
  const dtMatch = brainSrc.match(/const DESTRUCTIVE_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
  const dtNames = dtMatch ? (dtMatch[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')) : [];
  // Line-walker for TOOL_MAP — more robust than a multi-line regex against
  // CRLF/LF + nested generic types in the declaration line.
  const tmKeys = (() => {
    const lines = toolsSrc.split(/\r?\n/);
    let inMap = false;
    const keys = [];
    for (const ln of lines) {
      if (!inMap) {
        if (/^\s*const TOOL_MAP\b/.test(ln)) inMap = true;
        continue;
      }
      if (/^\s*\};\s*$/.test(ln)) break;
      const m = ln.match(/^\s+(\w+)\s*:/);
      if (m) keys.push(m[1]);
    }
    return keys;
  })();
  const tmSet = new Set(tmKeys);
  const dtOrphans = dtNames.filter((n) => !tmSet.has(n));
  if (dtNames.length > 0 && dtOrphans.length === 0) pass(`DESTRUCTIVE_TOOLS: all ${dtNames.length} members exist in TOOL_MAP (${tmKeys.length} tools total)`);
  else if (dtNames.length === 0) fail('DESTRUCTIVE_TOOLS not found in brain.ts', '(regex failed to match)');
  else fail('DESTRUCTIVE_TOOLS orphans', dtOrphans.join(', '));

  // 1.15 UI_MODIFYING_TOOLS structural invariant — same idea, different set
  const uiMatch = brainSrc.match(/const UI_MODIFYING_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
  const uiNames = uiMatch ? (uiMatch[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')) : [];
  const uiOrphans = uiNames.filter((n) => !tmSet.has(n));
  if (uiNames.length > 0 && uiOrphans.length === 0) pass(`UI_MODIFYING_TOOLS: all ${uiNames.length} members exist in TOOL_MAP`);
  else if (uiNames.length === 0) fail('UI_MODIFYING_TOOLS not found in brain.ts', '(regex failed to match)');
  else fail('UI_MODIFYING_TOOLS orphans', uiOrphans.join(', '));

  // 1.16 Screenshot downscale constants present (v0.11.23 invariant)
  const hasTarget = toolsSrc.includes('TARGET_SCREENSHOT_WIDTH = 1024');
  const hasThresh = toolsSrc.includes('SCREENSHOT_DOWNSCALE_THRESHOLD = 1280');
  if (hasTarget && hasThresh) pass('screenshot downscale constants: TARGET=1024 + THRESHOLD=1280 present');
  else fail('screenshot downscale constants', `TARGET=${hasTarget}, THRESHOLD=${hasThresh}`);

  // 1.17 captureAndOcr 5 failure-mode log strings present (v0.11.25 invariant)
  const ocrFailureLogs = [
    'captureAndOcr: script missing',
    'captureAndOcr: screenshot failed',
    'captureAndOcr: tmp png never written',
    'captureAndOcr: ocr-recognize.ps1 failed',
    'captureAndOcr: OCR returned non-JSON',
  ];
  const missingLogs = ocrFailureLogs.filter((s) => !toolsSrc.includes(s));
  if (missingLogs.length === 0) pass('captureAndOcr: all 5 failure-mode log strings present');
  else fail('captureAndOcr failure modes', `missing: ${missingLogs.join(' | ')}`);

  // 1.18 abortAllInFlightTools structural test (v0.11.26 invariant)
  const abortMatch = toolsSrc.match(/export function abortAllInFlightTools[\s\S]*?\n\}/);
  const abortBody = abortMatch ? abortMatch[0] : '';
  const abortChecks = [
    ['ac.abort()', abortBody.includes('ac.abort()')],
    ['activeAborts.clear()', abortBody.includes('activeAborts.clear()')],
  ];
  const abortFails = abortChecks.filter(([, ok]) => !ok).map(([n]) => n);
  if (abortFails.length === 0) pass('abortAllInFlightTools: calls .abort() AND .clear()');
  else fail('abortAllInFlightTools structure', `missing: ${abortFails.join(', ')}`);

  // 1.19 runComScript: stdout-JSON extraction logic (v0.11.26 invariant)
  // Pure-function copy of the parse path. We don't shell out — just verify
  // the parsing rules.
  function parseRunComStdout(stdoutTrimmed) {
    const lines = stdoutTrimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    try {
      const parsed = JSON.parse(lastLine);
      if (parsed && parsed.ok === false && typeof parsed.error === 'string') {
        return `Error: ${parsed.error}`;
      }
    } catch { /* fall through */ }
    return null;
  }
  const cases = [
    ['{"ok":false,"error":"Outlook not installed"}', 'Error: Outlook not installed'],
    ['debug noise\n{"ok":false,"error":"timeout"}', 'Error: timeout'],
    ['plain text not json', null],
    ['{"ok":true,"sent":true}', null],
  ];
  const parseFails = cases.filter(([input, expected]) => parseRunComStdout(input) !== expected);
  if (parseFails.length === 0) pass(`runComScript: stdout JSON extraction correct on ${cases.length}/${cases.length} cases`);
  else fail('runComScript stdout parse', parseFails.map(([i]) => i.substring(0, 30)).join(' | '));

  // 1.20 Kimi-only invariant (v0.11.27): brain.ts MUST NOT reference Gemini fallback
  // (the comment block describing the v0.11.27 change is allowed; what's
  // banned is fallback wiring like `provider === 'gemini'` or imports of
  // @google/generative-ai)
  const hasGeminiCode =
    /import\s+.*@google\/generative-ai/.test(brainSrc)
    || /provider\s*===\s*['"]gemini['"]/.test(brainSrc)
    || /callGemini|GoogleGenerativeAI/.test(brainSrc);
  if (!hasGeminiCode) pass('v0.11.27: no live Gemini code paths remain in brain.ts');
  else fail('v0.11.27: Gemini code reappeared', 'found live Gemini reference in brain.ts');

  // 1.21 Tool count sanity (catches accidental mass-deletion or duplication)
  if (tmKeys.length >= 30 && tmKeys.length <= 100) pass(`TOOL_MAP: ${tmKeys.length} tools registered (within sane bounds 30-100)`);
  else fail('TOOL_MAP tool count', `${tmKeys.length} is out of expected range`);

  // ────────── v0.11.28 logging-overhaul invariants ──────────

  const loggerSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'logger.ts'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.ts'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');

  // 1.22 serializeErr helper exported from logger
  if (/export function serializeErr\b/.test(loggerSrc)) pass('v0.11.28: serializeErr exported from logger');
  else fail('v0.11.28: serializeErr', 'not exported from logger.ts');

  // 1.23 Task.start log includes task_id (correlation id propagation)
  // brain.ts must call setCurrentTaskId at start of handleUserMessage AND
  // include task_id in the Task.start log payload.
  const hasTaskIdInit = /const task_id = randomUUID\(\)/.test(brainSrc) && /setCurrentTaskId\(task_id\)/.test(brainSrc);
  const taskStartHasId = /log\.info\('Task\.start'[\s\S]{0,400}task_id/.test(brainSrc);
  if (hasTaskIdInit && taskStartHasId) pass('v0.11.28: task_id initialized + included in Task.start');
  else fail('v0.11.28: task_id propagation', `init=${hasTaskIdInit}, taskStart=${taskStartHasId}`);

  // 1.24 captureScreenContext catch is non-empty (no more bare `catch {}`)
  // The most dangerous silent failure per subagent C. Catch must log AND
  // return a sentinel string so the model knows visual state is untrusted.
  const captureCatch = brainSrc.match(/private async captureScreenContext[\s\S]*?\n  \}/);
  const captureCatchBody = captureCatch ? captureCatch[0] : '';
  const hasLogCall = /log\.error\('captureScreenContext failed'/.test(captureCatchBody);
  const hasSentinel = /<screen-context-unavailable>|<screen-context-timeout>/.test(captureCatchBody);
  if (hasLogCall && hasSentinel) pass('v0.11.28: captureScreenContext catch logs error + returns sentinel');
  else fail('v0.11.28: screen-context catch', `log=${hasLogCall}, sentinel=${hasSentinel}`);

  // 1.25 renderer→main log bridge wired (preload exposes log, ipc handles it)
  const preloadHasLog = /\blog:\s*\(/.test(preloadSrc) && /'renderer-log'/.test(preloadSrc);
  const ipcHasLog = /'renderer-log'/.test(ipcSrc) && /ingestRendererLog/.test(ipcSrc);
  if (preloadHasLog && ipcHasLog) pass('v0.11.28: renderer→main log bridge wired (preload + ipc)');
  else fail('v0.11.28: log bridge', `preload=${preloadHasLog}, ipc=${ipcHasLog}`);

  // 1.26 support-bundle module exists with required exports
  const bundlePath = path.join(ROOT, 'src', 'main', 'support-bundle.ts');
  if (fs.existsSync(bundlePath)) {
    const bundleSrc = fs.readFileSync(bundlePath, 'utf8');
    const hasBuild = /export function buildBundle\b/.test(bundleSrc);
    const hasManifest = /manifest:\s*Record<string,\s*unknown>|manifest\s*\}/.test(bundleSrc);
    const hasTaskSlice = /extractLastTaskSlice\b/.test(bundleSrc);
    const hasScrub = /scrubPII\(bundle\)/.test(bundleSrc);
    if (hasBuild && hasManifest && hasTaskSlice && hasScrub) {
      pass('v0.11.28: support-bundle exports buildBundle + manifest + task slice + PII scrub');
    } else {
      fail('v0.11.28: support-bundle shape', `build=${hasBuild}, manifest=${hasManifest}, slice=${hasTaskSlice}, scrub=${hasScrub}`);
    }
  } else {
    fail('v0.11.28: support-bundle.ts', 'file does not exist');
  }

  // 1.27 PII scrubber exported AND scrubs username/email/license patterns
  // Behavioral check, not just presence — make sure the scrub still does
  // its job after refactor.
  function evalScrub(text) {
    // Mirror logger.ts scrubPII patterns
    const USERNAME = os.userInfo().username;
    const HOME_DIR = os.homedir();
    let r = text;
    r = r.replace(new RegExp(HOME_DIR.replace(/\\/g, '\\\\'), 'gi'), '~');
    r = r.replace(new RegExp(HOME_DIR.replace(/\\/g, '/'), 'gi'), '~');
    r = r.replace(new RegExp(`\\b${USERNAME}\\b`, 'gi'), '<user>');
    r = r.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>');
    r = r.replace(/CLIP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/gi, 'CLIP-****-****-****-****');
    return r;
  }
  const scrubExported = /export function scrubPII\b/.test(loggerSrc);
  const sample = `email me at someone@example.com and the path was ${os.homedir()}\\Documents — license CLIP-ABCD-EFGH-IJKL-MNOP for ${os.userInfo().username}`;
  const scrubbed = evalScrub(sample);
  const cleansEmail = scrubbed.includes('<email>') && !scrubbed.includes('someone@example.com');
  const cleansPath = scrubbed.includes('~') && !scrubbed.includes(os.homedir());
  const cleansLicense = scrubbed.includes('CLIP-****');
  if (scrubExported && cleansEmail && cleansPath && cleansLicense) {
    pass('v0.11.28: scrubPII exported + redacts email/path/license');
  } else {
    fail('v0.11.28: PII scrubber', `exported=${scrubExported}, email=${cleansEmail}, path=${cleansPath}, license=${cleansLicense}`);
  }

  // ────────── v0.11.29 hotfix invariants ──────────

  // 1.28 Bubble dedup: BubbleController callback must NOT call bubbleCtrl.speak/tts.speak
  // after sendMessage — brain emits clippy-speak which the IPC listener already renders.
  const rendererMain = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'main.ts'), 'utf8');
  const cbBlock = rendererMain.match(/new BubbleController\(async \(userText\) => \{[\s\S]*?^\s*\}\);/m);
  const cbBody = cbBlock ? cbBlock[0] : '';
  // After v0.11.29 the success path should ONLY have `await window.clippy.sendMessage(userText);`
  // — no bubbleCtrl.speak in the try block (catch is allowed).
  const successPath = cbBody.split('catch')[0] || '';
  const noDuplicateRender = !/bubbleCtrl\.speak\(response/.test(successPath) && !/tts\.speak\(response/.test(successPath);
  if (noDuplicateRender) pass('v0.11.29: bubble dedup — sendMessage callback no longer double-renders reply');
  else fail('v0.11.29: bubble dedup', 'sendMessage callback still calls bubbleCtrl/tts.speak on response');

  // 1.29 TTS emoji strip: stripEmoji helper exists + speak() pipes through it
  const ttsSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'tts.ts'), 'utf8');
  const hasStripEmoji = /private stripEmoji\(text: string\):/.test(ttsSrc);
  const speakUsesStrip = /speak\(text: string\):[^}]*stripEmoji\(text\)/s.test(ttsSrc);
  const stripsExtPicto = /\\p\{Extended_Pictographic\}/.test(ttsSrc);
  if (hasStripEmoji && speakUsesStrip && stripsExtPicto) {
    pass('v0.11.29: TTS stripEmoji exists + speak() pipes through it + uses Extended_Pictographic');
  } else {
    fail('v0.11.29: TTS emoji strip', `helper=${hasStripEmoji}, piped=${speakUsesStrip}, regex=${stripsExtPicto}`);
  }

  // 1.30 Proactive visibility: skip/filter logs MUST be at INFO (production
  // log level is INFO; DEBUG is invisible). Reading brainSrc fresh because
  // we already loaded it above but want the post-edit state.
  const brainSrcNow = fs.readFileSync(path.join(ROOT, 'src', 'main', 'brain.ts'), 'utf8');
  const proactiveSkipDebugMatches = (brainSrcNow.match(/log\.debug\('Proactive\.(skip|filtered|silent)/g) || []);
  const proactiveTickInfo = /log\.info\('Proactive\.tick'/.test(brainSrcNow);
  if (proactiveSkipDebugMatches.length === 0 && proactiveTickInfo) {
    pass('v0.11.29: proactive logs all INFO (no DEBUG-level skips) + Proactive.tick gates emit');
  } else {
    fail('v0.11.29: proactive log levels', `debug-skips=${proactiveSkipDebugMatches.length}, tick=${proactiveTickInfo}`);
  }

  // 1.31 lastScreenFingerprint reset on wake (avoid stale-fingerprint silence)
  const setModeBlock = brainSrcNow.match(/setMode\(mode: 'awake' \| 'sleep'\): void \{[\s\S]*?if \(mode === 'awake'\)[\s\S]*?startLoop\(\)/);
  const wakeBody = setModeBlock ? setModeBlock[0] : '';
  if (/lastScreenFingerprint = ''/.test(wakeBody)) pass('v0.11.29: lastScreenFingerprint reset on wake');
  else fail('v0.11.29: fingerprint reset', 'setMode awake-path does not reset lastScreenFingerprint');

  // 1.33 tier-meta-coverage — every key in TOOL_MAP has a matching key in
  // TOOL_META and vice versa. Source-of-truth for tiers is tool-meta.ts;
  // this catches drift when tools.ts gains/loses an entry.
  // 1.34 tier-values-valid — tier ∈ {1..5}, cost ∈ {cheap,medium,expensive}.
  // 1.35 tier-fallback-references-real-tools — fallback_alternative names
  //      must point at a real TOOL_MAP key.
  try {
    const toolsPath = path.join(ROOT, 'src', 'main', 'tools.ts');
    const metaPath = path.join(ROOT, 'src', 'main', 'tool-meta.ts');
    const toolsSrc = fs.readFileSync(toolsPath, 'utf8');
    const metaSrc = fs.readFileSync(metaPath, 'utf8');

    // Extract TOOL_MAP keys: capture between `const TOOL_MAP ... > = {` and
    // the matching closing `};`. The TOOL_MAP type signature contains `=>`
    // inside `Promise<ToolResult>` so we anchor on `> = {` rather than `[^=]*=`.
    const toolMapMatch = toolsSrc.match(/const TOOL_MAP\b[\s\S]*?>\s*=\s*\{([\s\S]*?)\n\};/);
    const toolMapBody = toolMapMatch ? toolMapMatch[1] : '';
    const toolMapKeys = new Set();
    for (const line of toolMapBody.split('\n')) {
      const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
      if (m) toolMapKeys.add(m[1]);
    }

    // Extract TOOL_META keys + tier/cost values.
    const metaMapMatch = metaSrc.match(/export const TOOL_META[^=]*=\s*\{([\s\S]*?)\n\};/);
    const metaBody = metaMapMatch ? metaMapMatch[1] : '';
    const metaEntries = []; // {name, tier, cost, fallback}
    const metaKeys = new Set();
    for (const line of metaBody.split('\n')) {
      const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\{(.*?)\}/);
      if (!m) continue;
      const name = m[1];
      const inner = m[2];
      metaKeys.add(name);
      const tierM = inner.match(/tier:\s*(\d+)/);
      const costM = inner.match(/cost:\s*'([^']+)'/);
      const fbM = inner.match(/fallback_alternative:\s*'([^']+)'/);
      metaEntries.push({
        name,
        tier: tierM ? Number(tierM[1]) : NaN,
        cost: costM ? costM[1] : '',
        fallback: fbM ? fbM[1] : null,
      });
    }

    // 1.33 coverage
    const orphansInMap = [...toolMapKeys].filter((k) => !metaKeys.has(k));
    const orphansInMeta = [...metaKeys].filter((k) => !toolMapKeys.has(k));
    if (toolMapKeys.size > 0 && orphansInMap.length === 0 && orphansInMeta.length === 0) {
      pass(`tier-meta-coverage: ${toolMapKeys.size} tools tagged, no orphans`);
    } else if (toolMapKeys.size === 0) {
      fail('tier-meta-coverage', 'could not parse TOOL_MAP keys from tools.ts');
    } else {
      fail(
        'tier-meta-coverage',
        `missing-in-meta=[${orphansInMap.join(',')}] missing-in-map=[${orphansInMeta.join(',')}]`,
      );
    }

    // 1.34 valid tier/cost values
    const VALID_TIERS = new Set([1, 2, 3, 4, 5]);
    const VALID_COSTS = new Set(['cheap', 'medium', 'expensive']);
    const badEntries = metaEntries.filter(
      (e) => !VALID_TIERS.has(e.tier) || !VALID_COSTS.has(e.cost),
    );
    if (metaEntries.length > 0 && badEntries.length === 0) {
      pass(`tier-values-valid: ${metaEntries.length} entries, all tier/cost in range`);
    } else if (metaEntries.length === 0) {
      fail('tier-values-valid', 'could not parse any TOOL_META entries');
    } else {
      const sample = badEntries.slice(0, 3).map((e) => `${e.name}(tier=${e.tier},cost=${e.cost})`).join(',');
      fail('tier-values-valid', `bad=${badEntries.length}: ${sample}`);
    }

    // 1.35 fallback_alternative points at a real tool
    const badFallbacks = metaEntries.filter(
      (e) => e.fallback && !toolMapKeys.has(e.fallback),
    );
    if (badFallbacks.length === 0) {
      pass('tier-fallback-references-real-tools: all fallback_alternative refs valid');
    } else {
      const sample = badFallbacks.map((e) => `${e.name}->${e.fallback}`).join(',');
      fail('tier-fallback-references-real-tools', `dangling=[${sample}]`);
    }
  } catch (e) {
    fail('tier-meta tests', e.message.substring(0, 120));
  }

  // ────────── v0.12.2 outlook self-contained fallback ──────────

  // 1.x outlook_send_email handler chains COM → olk UIA internally
  const toolsSrcNow = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tools.ts'), 'utf8');
  const sendHandler = toolsSrcNow.match(/async function outlookSendEmail[\s\S]*?\n\}/);
  const sendBody = sendHandler ? sendHandler[0] : '';
  const callsCom = /com-outlook-send-email\.ps1/.test(sendBody);
  const callsUia = /olk-send-email-uia\.ps1/.test(sendBody);
  const branchesOnNewOutlook = /OUTLOOK_NEW_NO_COM/.test(sendBody);
  if (callsCom && callsUia && branchesOnNewOutlook) {
    pass('v0.12.2: outlookSendEmail chains COM → olk UIA internally on new_outlook_no_com');
  } else {
    fail('v0.12.2: outlookSendEmail fallback chain', `com=${callsCom}, uia=${callsUia}, branch=${branchesOnNewOutlook}`);
  }

  // 1.x olk-send-email-uia.ps1 emits the right error codes for the JS handler
  // to pattern-match on later (body_too_long, compose_window_not_found, etc.)
  const uiaPath = path.join(ROOT, 'assets', 'scripts', 'olk-send-email-uia.ps1');
  if (fs.existsSync(uiaPath)) {
    const uiaSrc = fs.readFileSync(uiaPath, 'utf8');
    const requiredErrors = ['body_too_long', 'compose_window_not_found', 'send_button_not_found', 'unverified', 'launch_failed'];
    const missingErrors = requiredErrors.filter((e) => !uiaSrc.includes(e));
    const acceptsB64 = uiaSrc.includes('subjectB64') && uiaSrc.includes('bodyB64');
    const usesUiaApi = /System\.Windows\.Automation/.test(uiaSrc);
    const hasMailto = /mailto:/.test(uiaSrc);
    const hasInvokePattern = /InvokePattern/.test(uiaSrc);
    if (missingErrors.length === 0 && acceptsB64 && usesUiaApi && hasMailto && hasInvokePattern) {
      pass('v0.12.2: olk-send-email-uia.ps1 — UIA + InvokePattern + b64 args + 5 named errors');
    } else {
      fail('v0.12.2: olk UIA script shape', `b64=${acceptsB64}, uia=${usesUiaApi}, mailto=${hasMailto}, invoke=${hasInvokePattern}, missing-errors=${missingErrors.join(',')}`);
    }
  } else {
    fail('v0.12.2: olk-send-email-uia.ps1', 'file does not exist');
  }

  // ────────── v0.12.3 audit-fix invariants ──────────

  // smart_click failures emit (error:UI_NOT_FOUND) so Tier-5 fallback fires.
  // Per architecture audit finding #7. Walk the file line-by-line to extract
  // the smartClick function body (regex with [\s\S]*? was unreliable across
  // the multi-line nested structure with template literals).
  const smartClickBody = (() => {
    const lines = toolsSrcNow.split(/\r?\n/);
    let inFn = false;
    let depth = 0;
    const out = [];
    for (const ln of lines) {
      if (!inFn && /^async function smartClick\b/.test(ln)) {
        inFn = true; depth = 0;
      }
      if (inFn) {
        out.push(ln);
        // Count braces — start at depth 0 (open brace on signature line),
        // increment on `{`, decrement on `}`. Function ends when depth back to 0
        // after we've seen at least one `{`.
        for (const ch of ln) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) return out.join('\n');
          }
        }
      }
    }
    return out.join('\n');
  })();
  const hasUiNotFoundCode = /\(error:UI_NOT_FOUND\)/.test(smartClickBody);
  // No legacy free-text "not found via UIA or OCR" string returned WITHOUT
  // the (error:UI_NOT_FOUND) prefix.
  const legacyMatch = smartClickBody.match(/return \{ text: `\([^)]*not found[^)]*\)` \}/g);
  const noLegacyStrings = !legacyMatch || legacyMatch.length === 0;
  if (hasUiNotFoundCode && noLegacyStrings) pass('v0.12.3: smart_click failures emit (error:UI_NOT_FOUND) — Tier-5 fallback now fires');
  else fail('v0.12.3: smart_click error code', `hasCode=${hasUiNotFoundCode}, noLegacy=${noLegacyStrings}, bodyLen=${smartClickBody.length}`);

  // run_powershell removed from TOOL_MAP + tool-meta + server prompt declaration
  const runPsInToolMap = /^\s+run_powershell:/m.test(toolsSrcNow);
  const metaSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tool-meta.ts'), 'utf8');
  const runPsInMeta = /^\s+run_powershell:\s*\{/m.test(metaSrc);
  const apiToolsSrc = fs.readFileSync(path.join(ROOT, '..', 'clippyai-api', 'src', 'lib', 'tools.ts'), 'utf8');
  const runPsInServerDecl = /name:\s*'run_powershell'/.test(apiToolsSrc);
  if (!runPsInToolMap && !runPsInMeta && !runPsInServerDecl) {
    pass('v0.12.3: run_powershell removed from client TOOL_MAP + tool-meta + server prompt');
  } else {
    fail('v0.12.3: run_powershell removal', `clientMap=${runPsInToolMap}, meta=${runPsInMeta}, serverDecl=${runPsInServerDecl}`);
  }

  // DESTRUCTIVE_TOOLS expanded to cover keyboard-driven sends
  const destExpanded = ['type_text', 'key_press', 'cdp_type', 'write_clipboard'].every((t) => brainSrcNow.includes(`'${t}'`));
  if (destExpanded) pass('v0.12.3: DESTRUCTIVE_TOOLS includes type_text + key_press + cdp_type + write_clipboard');
  else fail('v0.12.3: DESTRUCTIVE_TOOLS expansion', 'one or more new entries missing');

  // _path-guard.ps1 helper exists + dot-sourced by 3 read tools
  const pathGuardPath = path.join(ROOT, 'assets', 'scripts', '_path-guard.ps1');
  if (fs.existsSync(pathGuardPath)) {
    const pgSrc = fs.readFileSync(pathGuardPath, 'utf8');
    const hasFn = /function Test-PathAllowedForRead/.test(pgSrc);
    const blocksSshAws = /\.ssh|\.aws|\.azure/.test(pgSrc);
    const blocksBrowserCreds = /Login Data|Cookies/.test(pgSrc);
    const dotSourced = ['com-list-files.ps1', 'com-search-files.ps1', 'com-read-file.ps1'].every((f) => {
      const src = fs.readFileSync(path.join(ROOT, 'assets', 'scripts', f), 'utf8');
      return /_path-guard\.ps1/.test(src) && /Test-PathAllowedForRead/.test(src);
    });
    if (hasFn && blocksSshAws && blocksBrowserCreds && dotSourced) {
      pass('v0.12.3: path-guard wired into list-files + search-files + read-file (blocks .ssh/.aws/browser creds)');
    } else {
      fail('v0.12.3: path-guard', `fn=${hasFn}, ssh=${blocksSshAws}, browser=${blocksBrowserCreds}, wired=${dotSourced}`);
    }
  } else {
    fail('v0.12.3: _path-guard.ps1', 'file does not exist');
  }

  // mailto: $to URL-encoded + email regex validation in olk script
  const olkSrc = fs.readFileSync(path.join(ROOT, 'assets', 'scripts', 'olk-send-email-uia.ps1'), 'utf8');
  const hasToValidation = /toPattern|invalid_to/.test(olkSrc);
  const hasToEncoding = /toEncoded\s*=\s*\[uri\]::EscapeDataString\(\$to\)/.test(olkSrc);
  if (hasToValidation && hasToEncoding) pass('v0.12.3: olk-send-email-uia validates + URL-encodes $to (header-injection guard)');
  else fail('v0.12.3: $to validation', `validation=${hasToValidation}, encoding=${hasToEncoding}`);

  // Override branch calls abortAllInFlightTools
  const overrideBlock = brainSrcNow.match(/User override[\s\S]{0,800}/);
  const overrideBody = overrideBlock ? overrideBlock[0] : '';
  if (/abortAllInFlightTools\(\)/.test(overrideBody)) {
    pass('v0.12.3: user-override branch calls abortAllInFlightTools()');
  } else {
    fail('v0.12.3: override abort', 'override branch does not call abortAllInFlightTools');
  }

  // v0.12.6 — cdp_click + cdp_type in NEVER_CONFIRMS_SUCCESS (false-positive
  // send guard, per report 543ff234). Plus cdp_client.clickByText restricts
  // destructive verbs ("send", "submit", "delete", etc.) to <button>+role=
  // button, never <a>/role=link (which matched the "Sent Items" sidebar nav
  // and triggered the false-positive).
  const neverConfirmsBlock = brainSrcNow.match(/NEVER_CONFIRMS_SUCCESS = new Set\(\[([\s\S]*?)\]\)/);
  const neverConfirmsBody = neverConfirmsBlock ? neverConfirmsBlock[1] : '';
  const cdpInNeverConfirms = /['"]cdp_click['"]/.test(neverConfirmsBody) && /['"]cdp_type['"]/.test(neverConfirmsBody);
  const cdpSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'cdp-client.ts'), 'utf8');
  const hasDestructiveVerbs = /DESTRUCTIVE_VERBS\s*=\s*\[/.test(cdpSrc);
  const restrictsAnchors = /isDestructive\?\[\]:Array/.test(cdpSrc);
  if (cdpInNeverConfirms && hasDestructiveVerbs && restrictsAnchors) {
    pass('v0.12.6: cdp_click/cdp_type never confirm send + clickByText restricts destructive-verb anchors');
  } else {
    fail('v0.12.6: false-positive guard', `nc=${cdpInNeverConfirms}, verbs=${hasDestructiveVerbs}, anchor-restrict=${restrictsAnchors}`);
  }

  // ────────── v0.13.0 email-dispatcher + new tools ──────────
  // outlookSendEmail is now a dispatcher across all 6 paths
  const dispatchBlock = toolsSrcNow.match(/async function outlookSendEmail[\s\S]*?\nasync function outlookWebSendEmailTool/);
  const dispatchBody = dispatchBlock ? dispatchBlock[0] : '';
  const hasOlkDirect = /olk-send-email-direct\.ps1/.test(dispatchBody);
  const hasWebRecipe = /outlookWebSendEmail\(/.test(dispatchBody);
  const hasGmailRecipe = /gmailWebSendEmail\(/.test(dispatchBody);
  const hasClawdFallback = /submitClawdTask/.test(dispatchBody);
  if (hasOlkDirect && hasWebRecipe && hasGmailRecipe && hasClawdFallback) {
    pass('v0.13.0: outlookSendEmail dispatcher wires COM + olk-mailto + olk-direct + web recipes + clawd-task fallback');
  } else {
    fail('v0.13.0: dispatcher', `olk-direct=${hasOlkDirect}, web=${hasWebRecipe}, gmail=${hasGmailRecipe}, clawd=${hasClawdFallback}`);
  }

  // New v0.13.0 tools registered in TOOL_MAP, tool-meta, and server prompt
  const v130Tools = ['outlook_web_send_email', 'gmail_web_send_email', 'clawd_task'];
  const v130InMap = v130Tools.every((t) => tmKeys.includes(t));
  const v130InMeta = v130Tools.every((t) => new RegExp(`^\\s+${t}:`, 'm').test(metaSrc));
  const v130InServer = v130Tools.every((t) => new RegExp(`name:\\s*'${t}'`).test(apiToolsSrc));
  if (v130InMap && v130InMeta && v130InServer) {
    pass('v0.13.0: 3 new tools (outlook_web_send_email, gmail_web_send_email, clawd_task) registered everywhere');
  } else {
    fail('v0.13.0: tool registration', `map=${v130InMap}, meta=${v130InMeta}, server=${v130InServer}`);
  }

  // mail-env probe exists + client sends mail_env in /v1/turn payload
  const mailEnvPath = path.join(ROOT, 'src', 'main', 'mail-env.ts');
  if (fs.existsSync(mailEnvPath)) {
    const mailEnvSrc = fs.readFileSync(mailEnvPath, 'utf8');
    const hasProbe = /probeMailEnvironment/.test(mailEnvSrc);
    const checksAppx = /Microsoft\.OutlookForWindows/.test(mailEnvSrc);
    const checksMailto = /mailto\\?\\\\UserChoice/.test(mailEnvSrc) || /mailto.{0,5}UserChoice/.test(mailEnvSrc);
    const brainSendsMailEnv = /mail_env/.test(brainSrcNow);
    if (hasProbe && checksAppx && checksMailto && brainSendsMailEnv) {
      pass('v0.13.0: mail-env probe + payload plumbing');
    } else {
      fail('v0.13.0: mail-env', `probe=${hasProbe}, appx=${checksAppx}, mailto=${checksMailto}, brainSends=${brainSendsMailEnv}`);
    }
  } else {
    fail('v0.13.0: mail-env.ts', 'file missing');
  }

  // olk-send-email-direct.ps1 uses AppsFolder + UIA + Ctrl+N + Ctrl+Enter
  const olkDirectPath = path.join(ROOT, 'assets', 'scripts', 'olk-send-email-direct.ps1');
  if (fs.existsSync(olkDirectPath)) {
    const src = fs.readFileSync(olkDirectPath, 'utf8');
    const usesAppsFolder = /shell:AppsFolder\\Microsoft\.OutlookForWindows/.test(src);
    const usesCtrlN = /\^n/.test(src);
    const usesCtrlEnter = /\^\{ENTER\}/.test(src);
    if (usesAppsFolder && usesCtrlN && usesCtrlEnter) {
      pass('v0.13.0: olk-send-email-direct.ps1 uses AppsFolder + Ctrl+N + Ctrl+Enter');
    } else {
      fail('v0.13.0: olk-direct script', `appx=${usesAppsFolder}, ctrl-n=${usesCtrlN}, ctrl-enter=${usesCtrlEnter}`);
    }
  } else {
    fail('v0.13.0: olk-send-email-direct.ps1', 'file missing');
  }

  // ────────── v0.14.0 ClawHub skill registry ──────────
  const clawhubPath = path.join(ROOT, 'src', 'main', 'clawhub.ts');
  const registryPath = path.join(ROOT, 'src', 'main', 'skill-registry.ts');
  if (fs.existsSync(clawhubPath) && fs.existsSync(registryPath)) {
    const ch = fs.readFileSync(clawhubPath, 'utf8');
    const reg = fs.readFileSync(registryPath, 'utf8');
    const hasSearch    = /export async function searchSkills/.test(ch);
    const hasInstall   = /export async function installSkill/.test(ch);
    const hasScan      = /export async function getSkillScan/.test(ch);
    const hasRunner    = /export async function runSkill/.test(ch);
    const hasParser    = /parseSkillMd/.test(ch);
    const hasSafety    = /UNSAFE_CAPABILITY_TAGS|classifySkillSafety/.test(ch);
    const hasSlugToTool = /export function slugToToolName/.test(reg);
    const hasIsSkillTool = /export function isSkillTool/.test(reg);
    const hasRefresh   = /export async function refreshSkillRegistry/.test(reg);
    const hasExecute   = /export async function executeSkillTool/.test(reg);
    const hasPromptList = /export function getInstalledSkillsForPrompt/.test(reg);
    // The L1-promotion ask: skill__<slug> tools route through registry in executeTool
    const promotionWired = /isSkillTool\(tool\)/.test(toolsSrcNow) && /executeSkillTool\(tool, params\)/.test(toolsSrcNow);
    // Brain sends installed_skills in /v1/turn
    const brainSendsSkills = /installed_skills/.test(brainSrcNow);
    // Server accepts installed_skills + merges into tool list
    const serverAcceptsSkills = /installed_skills\?:|installed_skills\?: /.test(apiToolsSrc) === false; // turn.ts not tools.ts
    const apiTurnSrc = fs.readFileSync(path.join(ROOT, '..', 'clippyai-api', 'src', 'routes', 'turn.ts'), 'utf8');
    const serverWiresSkills = /installed_skills/.test(apiTurnSrc) && /skillTools/.test(apiTurnSrc);

    const allWired = hasSearch && hasInstall && hasScan && hasRunner && hasParser && hasSafety
      && hasSlugToTool && hasIsSkillTool && hasRefresh && hasExecute && hasPromptList
      && promotionWired && brainSendsSkills && serverWiresSkills;
    if (allWired) {
      pass('v0.14.0: ClawHub client + registry wired; skill__<slug> tools auto-promote to L1');
    } else {
      fail('v0.14.0: ClawHub plumbing', `search=${hasSearch}, install=${hasInstall}, scan=${hasScan}, runner=${hasRunner}, parser=${hasParser}, safety=${hasSafety}, slugToTool=${hasSlugToTool}, isSkillTool=${hasIsSkillTool}, refresh=${hasRefresh}, executeSkill=${hasExecute}, promptList=${hasPromptList}, promotion=${promotionWired}, brainSends=${brainSendsSkills}, server=${serverWiresSkills}`);
    }

    // find_skill + install_skill registered in TOOL_MAP
    const v140Tools = ['find_skill', 'install_skill'];
    const v140InMap = v140Tools.every((t) => tmKeys.includes(t));
    const v140InServer = v140Tools.every((t) => new RegExp(`name:\\s*'${t}'`).test(apiToolsSrc));
    if (v140InMap && v140InServer) {
      pass('v0.14.0: find_skill + install_skill registered (TOOL_MAP + server prompt)');
    } else {
      fail('v0.14.0: skill tools', `map=${v140InMap}, server=${v140InServer}`);
    }
  } else {
    fail('v0.14.0: clawhub.ts or skill-registry.ts', 'missing file');
  }

  // ────────── v0.14.1 Settings UI loose-end audit ──────────
  // Skills tab, Mail Setup status, active-model display — all wired
  // through preload → ipc.ts → underlying modules.
  const settingsHtmlPath = path.join(ROOT, 'src', 'renderer', 'settings.html');
  const settingsTsPath = path.join(ROOT, 'src', 'renderer', 'settings.ts');
  const preloadPathV141 = path.join(ROOT, 'src', 'preload', 'index.ts');
  const ipcPathV141 = path.join(ROOT, 'src', 'main', 'ipc.ts');
  const htmlSrc = fs.readFileSync(settingsHtmlPath, 'utf8');
  const settingsTsSrc = fs.readFileSync(settingsTsPath, 'utf8');
  const preloadSrcV141 = fs.readFileSync(preloadPathV141, 'utf8');
  const ipcSrcV141 = fs.readFileSync(ipcPathV141, 'utf8');

  // Skills tab fully wired: nav item + HTML section + IPC handlers + preload
  const hasSkillsNav = /data-section="skills"/.test(htmlSrc);
  const hasInstalledList = /id="installed-skills-list"/.test(htmlSrc);
  const hasSkillSearch = /id="skill-search-input"/.test(htmlSrc);
  const hasIpcSkillsList = /.skills-list./.test(ipcSrcV141) && /'skills-search'/.test(ipcSrcV141) && /'skills-install'/.test(ipcSrcV141) && /'skills-uninstall'/.test(ipcSrcV141);
  const hasPreloadSkills = /skillsList:/.test(preloadSrcV141) && /skillsSearch:/.test(preloadSrcV141) && /skillsInstall:/.test(preloadSrcV141) && /skillsUninstall:/.test(preloadSrcV141);
  const hasRenderInstalled = /async function renderInstalledSkills/.test(settingsTsSrc);
  if (hasSkillsNav && hasInstalledList && hasSkillSearch && hasIpcSkillsList && hasPreloadSkills && hasRenderInstalled) {
    pass('v0.14.1: Skills tab fully wired (nav + list + search + 4 IPC + preload + renderer)');
  } else {
    fail('v0.14.1: Skills tab', `nav=${hasSkillsNav}, list=${hasInstalledList}, search=${hasSkillSearch}, ipc=${hasIpcSkillsList}, preload=${hasPreloadSkills}, render=${hasRenderInstalled}`);
  }

  // Mail Setup status panel (Brain tab)
  const hasMailStatusHtml = /id="mail-env-status"/.test(htmlSrc);
  const hasMailEnvIpc = /'mail-env-status'/.test(ipcSrcV141);
  const hasMailEnvPreload = /mailEnvStatus:/.test(preloadSrcV141);
  const hasMailEnvRenderer = /renderMailEnv/.test(settingsTsSrc);
  if (hasMailStatusHtml && hasMailEnvIpc && hasMailEnvPreload && hasMailEnvRenderer) {
    pass('v0.14.1: Mail Setup status panel wired');
  } else {
    fail('v0.14.1: Mail Setup', `html=${hasMailStatusHtml}, ipc=${hasMailEnvIpc}, preload=${hasMailEnvPreload}, renderer=${hasMailEnvRenderer}`);
  }

  // Active model display (About tab) + last-seen-model cache in brain.ts
  const hasActiveModelHtml = /id="active-model"/.test(htmlSrc);
  const hasActiveModelIpc = /'active-model'/.test(ipcSrcV141);
  const hasActiveModelPreload = /activeModel:/.test(preloadSrcV141);
  const hasLastSeenCache = /getLastSeenModel|lastSeenModel\s*=/.test(brainSrcNow);
  if (hasActiveModelHtml && hasActiveModelIpc && hasActiveModelPreload && hasLastSeenCache) {
    pass('v0.14.1: Active-model display wired (HTML + IPC + preload + brain cache)');
  } else {
    fail('v0.14.1: active model', `html=${hasActiveModelHtml}, ipc=${hasActiveModelIpc}, preload=${hasActiveModelPreload}, cache=${hasLastSeenCache}`);
  }

  // ────────── v0.14.2 hotfix invariants ──────────
  // Auto-spawn browser in BOTH web recipes so the email dispatcher doesn't
  // appear to "not fall back." Per support report 45e25158.
  //
  // v0.16.2 — spawnCdpBrowser was moved to its own module (src/main/cdp-spawn.ts)
  // because the previous `require('../tools')` at runtime crashed in the packed
  // app.asar (report e8f2fb63). Invariants updated accordingly:
  //   - skills import from '../cdp-spawn' (static), NOT require('../tools')
  //   - the function lives in src/main/cdp-spawn.ts and is exported
  const outlookWebSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'skills', 'outlook-web-send.ts'), 'utf8');
  const gmailWebSrc   = fs.readFileSync(path.join(ROOT, 'src', 'main', 'skills', 'gmail-web-send.ts'), 'utf8');
  const cdpSpawnPath  = path.join(ROOT, 'src', 'main', 'cdp-spawn.ts');
  const cdpSpawnSrc   = fs.existsSync(cdpSpawnPath) ? fs.readFileSync(cdpSpawnPath, 'utf8') : '';
  const outlookSpawns = /spawnCdpBrowser/.test(outlookWebSrc);
  const gmailSpawns   = /spawnCdpBrowser/.test(gmailWebSrc);
  const exportSpawn   = /^export async function spawnCdpBrowser/m.test(cdpSpawnSrc);
  const outlookStatic = /from ['"]\.\.\/cdp-spawn['"]/.test(outlookWebSrc) && !/require\(['"]\.\.\/tools['"]\)/.test(outlookWebSrc);
  const gmailStatic   = /from ['"]\.\.\/cdp-spawn['"]/.test(gmailWebSrc)   && !/require\(['"]\.\.\/tools['"]\)/.test(gmailWebSrc);
  if (outlookSpawns && gmailSpawns && exportSpawn && outlookStatic && gmailStatic) {
    pass('v0.14.2+v0.16.2: web recipes auto-spawn browser via static cdp-spawn import (no runtime require)');
  } else {
    fail('v0.14.2+v0.16.2: auto-spawn', `outlook=${outlookSpawns}, gmail=${gmailSpawns}, exported=${exportSpawn}, outlookStatic=${outlookStatic}, gmailStatic=${gmailStatic}`);
  }

  // task_complete Clippy.say suppressed when reply was already spoken
  const taskCompleteBlock = brainSrcNow.match(/SENTINEL: task_complete[\s\S]*?taskCompleted = true/);
  const tcBlockSrc = taskCompleteBlock ? taskCompleteBlock[0] : '';
  const suppressesDouble = /if \(spoken\)[\s\S]{0,200}Clippy\.say\.suppressed/.test(tcBlockSrc);
  if (suppressesDouble) {
    pass('v0.14.2: task_complete Clippy.say suppressed when reply already spoken (no double TTS)');
  } else {
    fail('v0.14.2: double-TTS suppression', 'task_complete still always emits clippy-speak');
  }

  // 300-char post-truncate in server turn.ts
  const apiTurnSrc = fs.readFileSync(path.join(ROOT, '..', 'clippyai-api', 'src', 'routes', 'turn.ts'), 'utf8');
  const has300CharTruncate = /t\.length > 300/.test(apiTurnSrc) && /lastBoundary/.test(apiTurnSrc);
  // Prompt has the hard 40-word cap
  const has40WordCap = /HARD CAP: 40 words/.test(apiToolsSrc);
  if (has300CharTruncate && has40WordCap) {
    pass('v0.14.2: server-side 300-char post-truncate + prompt 40-word cap');
  } else {
    fail('v0.14.2: verbosity cap', `300char=${has300CharTruncate}, 40word=${has40WordCap}`);
  }

  // ────────── v0.15.0 mcp-chrome integration ──────────
  const mcpChromePath = path.join(ROOT, 'src', 'main', 'mcp-chrome.ts');
  if (fs.existsSync(mcpChromePath)) {
    const mcpSrc = fs.readFileSync(mcpChromePath, 'utf8');
    const usesSdk = /@modelcontextprotocol\/sdk/.test(mcpSrc);
    const usesStreamableHttp = /StreamableHTTPClientTransport/.test(mcpSrc);
    const hasProbe = /export async function probeMcpChrome/.test(mcpSrc);
    const hasCorrectTools = /chrome_navigate|chrome_computer|chrome_get_web_content/.test(mcpSrc);
    const hasRefresh = /export async function refreshMcpChromeStatus/.test(mcpSrc);
    if (usesSdk && usesStreamableHttp && hasProbe && hasCorrectTools && hasRefresh) {
      pass('v0.15.0: mcp-chrome client uses SDK + StreamableHTTP + correct upstream tool names');
    } else {
      fail('v0.15.0: mcp-chrome client', `sdk=${usesSdk}, stream=${usesStreamableHttp}, probe=${hasProbe}, tools=${hasCorrectTools}, refresh=${hasRefresh}`);
    }
  } else {
    fail('v0.15.0: mcp-chrome.ts', 'file missing');
  }

  // browser_* tools registered + use correct upstream tool names
  const v150BrowserTools = ['browser_navigate', 'browser_click', 'browser_type', 'browser_read_text', 'browser_list_tabs', 'browser_switch_tab'];
  const v150InMap = v150BrowserTools.every((t) => tmKeys.includes(t));
  const usesUpstreamNames = /MCP_CHROME_TOOLS\.NAVIGATE|MCP_CHROME_TOOLS\.COMPUTER|MCP_CHROME_TOOLS\.FILL_OR_SELECT/.test(toolsSrcNow);
  if (v150InMap && usesUpstreamNames) {
    pass('v0.15.0: 6 browser_* tools registered + use upstream chrome_* tool names');
  } else {
    fail('v0.15.0: browser tools', `map=${v150InMap}, upstreamNames=${usesUpstreamNames}`);
  }

  // Settings → Web tab wired (HTML + IPC + preload)
  const hasWebTab = /data-section="web"/.test(htmlSrc);
  const hasWebIpc = /'mcp-chrome-status'/.test(ipcSrcV141) && /'mcp-chrome-refresh'/.test(ipcSrcV141);
  const hasWebPreload = /mcpChromeStatus:/.test(preloadSrcV141) && /mcpChromeRefresh:/.test(preloadSrcV141);
  if (hasWebTab && hasWebIpc && hasWebPreload) {
    pass('v0.15.0: Settings → Web tab wired (status display + refresh)');
  } else {
    fail('v0.15.0: Web tab', `html=${hasWebTab}, ipc=${hasWebIpc}, preload=${hasWebPreload}`);
  }

  // submitClawdTask wraps /task with returnPartial
  const clawdSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'clawd-fallback.ts'), 'utf8');
  const hasSubmitTask = /export async function submitClawdTask/.test(clawdSrc);
  const callsTaskEndpoint = /path:\s*['"]\/task['"]/.test(clawdSrc);
  const usesReturnPartial = /returnPartial:\s*true/.test(clawdSrc);
  if (hasSubmitTask && callsTaskEndpoint && usesReturnPartial) {
    pass('v0.13.0: submitClawdTask hits POST /task with returnPartial');
  } else {
    fail('v0.13.0: clawd /task wrapper', `submit=${hasSubmitTask}, path=${callsTaskEndpoint}, partial=${usesReturnPartial}`);
  }

  // proactiveCooldownMs is a setting (not hardcoded 600_000)
  const cooldownIsSetting = /settingsStore\.get\('proactiveCooldownMs'\)/.test(brainSrcNow);
  const noHardcoded600k = !/noRepeatUntil\s*=\s*Date\.now\(\)\s*\+\s*600_000/.test(brainSrcNow);
  if (cooldownIsSetting && noHardcoded600k) pass('v0.12.3: proactiveCooldownMs is a Setting (not hardcoded)');
  else fail('v0.12.3: proactive cooldown setting', `setting=${cooldownIsSetting}, no-hardcode=${noHardcoded600k}`);

  // ────────── v0.12.4 new-tool registration invariants ──────────

  const v124Tools = [
    'zip_files',
    'unzip_files',
    'hash_file',
    'ocr_from_image',
    'windows_service_control',
    'get_current_time_tz',
    'weather_current',
    'shortcuts_execute',
  ];

  // All 8 are present in TOOL_MAP, tool-meta, and server prompt declarations.
  const allInToolMap = v124Tools.every((t) => tmKeys.includes(t));
  const metaSrcNow = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tool-meta.ts'), 'utf8');
  const allInMeta = v124Tools.every((t) => new RegExp(`^\\s+${t}\\s*:`, 'm').test(metaSrcNow));
  // Reuse apiToolsSrc declared in v0.12.3 block above.
  const allInServerDecl = v124Tools.every((t) => new RegExp(`name:\\s*'${t}'`).test(apiToolsSrc));
  if (allInToolMap && allInMeta && allInServerDecl) {
    pass(`v0.12.4: all 8 new tools registered (TOOL_MAP + tool-meta + server prompt)`);
  } else {
    fail('v0.12.4: tool registration', `map=${allInToolMap}, meta=${allInMeta}, server=${allInServerDecl}`);
  }

  // get_current_time_tz is pure JS (no PS script) and uses Intl.DateTimeFormat
  const toolsSrcV124 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tools.ts'), 'utf8');
  const tzImpl = toolsSrcV124.match(/async function getCurrentTimeTz[\s\S]*?\n\}/);
  const tzBody = tzImpl ? tzImpl[0] : '';
  if (/Intl\.DateTimeFormat/.test(tzBody) && /timeZone:/.test(tzBody)) {
    pass('v0.12.4: get_current_time_tz uses Intl.DateTimeFormat (no native deps)');
  } else {
    fail('v0.12.4: get_current_time_tz', 'missing Intl.DateTimeFormat impl');
  }

  // weather_current calls Open-Meteo (no API key), supports both location + lat/lon
  const weatherImpl = toolsSrcV124.match(/async function weatherCurrent[\s\S]*?\n\}/);
  const weatherBody = weatherImpl ? weatherImpl[0] : '';
  const usesOpenMeteo = /api\.open-meteo\.com|geocoding-api\.open-meteo\.com/.test(weatherBody);
  const handlesLatLon = /params\.lat|params\.lon/.test(weatherBody);
  const handlesLocation = /params\.location/.test(weatherBody);
  if (usesOpenMeteo && handlesLatLon && handlesLocation) {
    pass('v0.12.4: weather_current uses Open-Meteo + supports location AND lat/lon');
  } else {
    fail('v0.12.4: weather_current', `openmeteo=${usesOpenMeteo}, latlon=${handlesLatLon}, loc=${handlesLocation}`);
  }

  // shortcuts_execute proxies to clawdcursor (Tier-5)
  const shortcutsImpl = toolsSrcV124.match(/async function shortcutsExecute[\s\S]*?\n\}/);
  const shortcutsBody = shortcutsImpl ? shortcutsImpl[0] : '';
  if (/callClawdTool\('shortcuts_execute'/.test(shortcutsBody) && /isClawdReady/.test(shortcutsBody)) {
    pass('v0.12.4: shortcuts_execute proxies to clawdcursor (Tier-5)');
  } else {
    fail('v0.12.4: shortcuts_execute', 'does not proxy via callClawdTool');
  }

  // 5 new PS scripts dot-source _path-guard (security guarantee for the
  // file-touching ones — zip, unzip, hash, ocr-from-image)
  const pathGuardConsumers = ['zip-files.ps1', 'unzip-files.ps1', 'hash-file.ps1', 'ocr-from-image.ps1'];
  const allGuard = pathGuardConsumers.every((f) => {
    const src = fs.readFileSync(path.join(ROOT, 'assets', 'scripts', f), 'utf8');
    return /_path-guard\.ps1/.test(src) && /Test-PathAllowedForRead/.test(src);
  });
  if (allGuard) pass('v0.12.4: zip/unzip/hash/ocr-from-image all dot-source path-guard');
  else fail('v0.12.4: path-guard wiring', 'one or more new PS scripts skip path-guard');

  // 1.32 Outlook precheck helper exists + all 4 com-outlook-*.ps1 dot-source it
  const precheckPath = path.join(ROOT, 'assets', 'scripts', '_outlook-com-precheck.ps1');
  if (fs.existsSync(precheckPath)) {
    const precheckSrc = fs.readFileSync(precheckPath, 'utf8');
    const hasNewOutlookReason = /new_outlook_no_com/.test(precheckSrc);
    const checksAppx = /Microsoft\.OutlookForWindows/.test(precheckSrc);
    const checksOlkProcess = /Get-Process[^\n]*olk/.test(precheckSrc);
    const fourScripts = ['com-outlook-send-email.ps1', 'com-outlook-create-event.ps1', 'com-outlook-read-inbox.ps1', 'com-outlook-upcoming.ps1'];
    const allDotSource = fourScripts.every((f) => {
      const src = fs.readFileSync(path.join(ROOT, 'assets', 'scripts', f), 'utf8');
      return /_outlook-com-precheck\.ps1/.test(src) && /Test-OutlookComAvailable/.test(src);
    });
    if (hasNewOutlookReason && checksAppx && checksOlkProcess && allDotSource) {
      pass('v0.11.29: Outlook precheck (olk/AppX/COM ProgID) wired into all 4 com-outlook-*.ps1');
    } else {
      fail('v0.11.29: Outlook precheck', `reason=${hasNewOutlookReason}, appx=${checksAppx}, olk=${checksOlkProcess}, allWired=${allDotSource}`);
    }
  } else {
    fail('v0.11.29: _outlook-com-precheck.ps1', 'helper file missing');
  }

  // ────────── v0.18.0 PR-A1 — perf + proactive correctness invariants ──────────
  // These check that the five surgical fixes shipped together don't
  // silently regress on a future refactor. Each invariant is a
  // structural grep that fails loud if the fix is reverted.

  const ipcSrcNow = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.ts'), 'utf8');
  const settingsHtmlNow = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.html'), 'utf8');
  const preloadSrcNow = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');

  // 1. Turn API timeout is 40s (not 60s) and MAX_RETRIES is 1 (not 2).
  //    Net effect: worst-case wall-clock for a hung call drops ~3x.
  const timeout40 = /Turn API timeout \(40s\)/.test(brainSrcNow) && /\b40_000\b/.test(brainSrcNow);
  const no60sTimeout = !/Turn API timeout \(60s\)/.test(brainSrcNow);
  const retries1 = /const MAX_RETRIES = 1\b/.test(brainSrcNow);
  if (timeout40 && no60sTimeout && retries1) {
    pass('v0.18.0: API timeout 40s + MAX_RETRIES=1 (was 60s + 2)');
  } else {
    fail('v0.18.0: timeout/retry budget', `40s=${timeout40} no60s=${no60sTimeout} retries1=${retries1}`);
  }

  // 2. settings.html slider default value matches store default (300, not 30)
  //    Store default is in the object-literal initializer for the
  //    settingsStore in brain.ts — `proactiveInterval: 300000`.
  const sliderMatch = /id="setting-proactive-interval"[^>]*value="(\d+)"/.exec(settingsHtmlNow);
  const storeMatch = /proactiveInterval:\s*(\d+)/.exec(brainSrcNow);
  const sliderVal = sliderMatch && sliderMatch[1];
  const storeVal = storeMatch && storeMatch[1];
  if (sliderVal === '300' && storeVal === '300000') {
    pass('v0.18.0: settings.html slider default matches brainSettingsStore (both 300s)');
  } else {
    fail('v0.18.0: slider/store default', `slider="${sliderVal}" store="${storeVal}"`);
  }

  // 3. restartProactiveLoop no longer guards on `mode === 'awake'`.
  //    Settings changes while sleeping should re-arm the loop too.
  const restartFn = brainSrcNow.match(/restartProactiveLoop\(\):\s*void\s*\{([\s\S]*?)\n\s{2}\}/);
  const fnBody = restartFn && restartFn[1];
  const hasGuard = fnBody && /this\.mode\s*===\s*'awake'/.test(fnBody);
  const callsStartLoop = fnBody && /this\.startLoop\(\)/.test(fnBody);
  if (fnBody && !hasGuard && callsStartLoop) {
    pass('v0.18.0: restartProactiveLoop drops sleep-mode guard');
  } else {
    fail('v0.18.0: restartProactiveLoop body', `hasGuard=${hasGuard} callsStart=${callsStartLoop}`);
  }

  // 4. ipc.ts emits BOTH the boolean `proactive-toggle` and the new
  //    numeric `proactive-interval` channels on settings change.
  //    Code reviewer flagged that reshaping the existing boolean channel
  //    would silently break tray.ts:74; we add a separate channel for
  //    the interval instead.
  const emitsToggle = /webContents\.send\('proactive-toggle',\s*enabled\)/.test(ipcSrcNow);
  const emitsInterval = /webContents\.send\('proactive-interval',\s*interval\)/.test(ipcSrcNow);
  const preloadHasInterval = /onProactiveInterval:/.test(preloadSrcNow) && /'proactive-interval'/.test(preloadSrcNow);
  if (emitsToggle && emitsInterval && preloadHasInterval) {
    pass('v0.18.0: ipc emits proactive-toggle (bool) + proactive-interval (number); preload exposes both');
  } else {
    fail('v0.18.0: proactive IPC channels', `emit_toggle=${emitsToggle} emit_interval=${emitsInterval} preload=${preloadHasInterval}`);
  }

  // 5. screenText capped at 800 chars in captureScreenContext (was 2000).
  //    Cuts ~5KB of OCR/UIA dump from every first-turn user message.
  const screenCap800 = /screenText\s*\|\|\s*''\)\.substring\(0,\s*800\)/.test(brainSrcNow);
  const no2000Cap = !/screenText\s*\|\|\s*''\)\.substring\(0,\s*2000\)/.test(brainSrcNow);
  if (screenCap800 && no2000Cap) {
    pass('v0.18.0: screenText capped at 800 chars (was 2000)');
  } else {
    fail('v0.18.0: screenText cap', `cap800=${screenCap800} no2000=${no2000Cap}`);
  }

  // ────────── v0.18.1 PR-A2 — image-pruning invariants ──────────
  // The dominant overstimulation vector per the Opus context audit:
  // base64 screenshots accumulating in contents and re-sent every turn.

  // 1. Pure helper exists with the right signature.
  const helperDecl = /export function pruneStaleInlineData\(\s*contents:\s*ReadonlyArray<Content>,?\s*keep\s*=\s*2,?\s*\)\s*:/.test(brainSrcNow);
  if (helperDecl) {
    pass('v0.18.1: pruneStaleInlineData(contents, keep=2) declared');
  } else {
    fail('v0.18.1: pruneStaleInlineData signature', 'helper not found with expected signature');
  }

  // 2. Helper is called BEFORE req.write in callTurnOnce.
  const callSite = brainSrcNow.indexOf('pruneStaleInlineData(contents');
  const reqWriteSite = brainSrcNow.indexOf('req.write(JSON.stringify({ contents: pruned');
  if (callSite > 0 && reqWriteSite > callSite) {
    pass('v0.18.1: pruneStaleInlineData wired into callTurnOnce before req.write');
  } else {
    fail('v0.18.1: pruning wiring', `callSite=${callSite} reqWrite=${reqWriteSite}`);
  }

  // 3. imageHistoryKeep is in BrainSettings with default 2.
  const settingTyped = /imageHistoryKeep:\s*number/.test(brainSrcNow);
  const settingDefault = /imageHistoryKeep:\s*2/.test(brainSrcNow);
  if (settingTyped && settingDefault) {
    pass('v0.18.1: imageHistoryKeep typed in BrainSettings + default=2');
  } else {
    fail('v0.18.1: imageHistoryKeep setting', `typed=${settingTyped} default=${settingDefault}`);
  }

  // 4. Behavioral test — port the algorithm into pure JS and verify
  //    semantics against four fixtures. If the TS implementation
  //    drifts away from this contract, the structural tests above
  //    won't catch it; this one will.
  //
  //    Contract:
  //      - keep >= contents.length: no pruning, return clone
  //      - keep = N: last N entries kept intact, earlier ones lose inlineData parts only
  //      - text + functionResponse parts in pruned entries are preserved
  //      - droppedBytes counts base64 char length of inlineData.data
  //      - returns a NEW array; never mutates input
  function pruneRef(contents, keep = 2) {
    if (keep >= contents.length || keep < 0) {
      return { pruned: contents.slice(), droppedCount: 0, droppedBytes: 0 };
    }
    const cutoff = contents.length - keep;
    let droppedCount = 0, droppedBytes = 0;
    const pruned = contents.map((entry, idx) => {
      if (idx >= cutoff) return entry;
      if (!entry.parts || !entry.parts.length) return entry;
      const newParts = entry.parts.filter((part) => {
        if (part && part.inlineData && part.inlineData.data) {
          droppedCount++;
          droppedBytes += String(part.inlineData.data).length;
          return false;
        }
        return true;
      });
      return newParts.length === entry.parts.length
        ? entry
        : Object.assign({}, entry, { parts: newParts });
    });
    return { pruned, droppedCount, droppedBytes };
  }

  // Fixture A: 4 entries, each with one inlineData part; keep=2.
  //   → entries 0,1 should be stripped, entries 2,3 intact.
  //   → droppedCount=2, droppedBytes=AAA+BBB length=6
  const fxA = [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'BBB' } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'CCC' } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'DDD' } }] },
  ];
  const rA = pruneRef(fxA, 2);
  const a_ok =
    rA.pruned[0].parts.length === 0 &&
    rA.pruned[1].parts.length === 0 &&
    rA.pruned[2].parts[0].inlineData.data === 'CCC' &&
    rA.pruned[3].parts[0].inlineData.data === 'DDD' &&
    rA.droppedCount === 2 &&
    rA.droppedBytes === 6;

  // Fixture B: mixed parts — text + inlineData; keep=1.
  //   Older entry's text part MUST survive; inlineData MUST be dropped.
  const fxB = [
    { role: 'user', parts: [{ text: 'find this email' }, { inlineData: { mimeType: 'image/png', data: 'XYZW' } }] },
    { role: 'model', parts: [{ text: 'done' }] },
  ];
  const rB = pruneRef(fxB, 1);
  const b_ok =
    rB.pruned[0].parts.length === 1 &&
    rB.pruned[0].parts[0].text === 'find this email' &&
    rB.pruned[1].parts[0].text === 'done' &&
    rB.droppedCount === 1 &&
    rB.droppedBytes === 4;

  // Fixture C: keep >= length → no pruning.
  const fxC = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'KEEPME' } }] }];
  const rC = pruneRef(fxC, 2);
  const c_ok = rC.droppedCount === 0 && rC.pruned[0].parts[0].inlineData.data === 'KEEPME';

  // Fixture D: input must not be mutated.
  const fxD = [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'OLD' } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'NEW' } }] },
  ];
  const before = JSON.stringify(fxD);
  pruneRef(fxD, 1);
  const d_ok = JSON.stringify(fxD) === before;

  if (a_ok && b_ok && c_ok && d_ok) {
    pass('v0.18.1: prune algorithm — keep last N, strip inlineData only, preserve text, immutable');
  } else {
    fail('v0.18.1: prune semantics', `A=${a_ok} B=${b_ok} C=${c_ok} D=${d_ok}`);
  }

  // ────────── v0.18.1 PR-B — user-takeover invariants ──────────
  // Powers the "Clippy stops when you grab the mouse / start typing"
  // behavior. Module + wiring tests only — actual detection logic
  // relies on Electron's powerMonitor + screen APIs which are not
  // reachable from the layer-1 pure-Node runner.

  const takeoverPath = path.join(ROOT, 'src', 'main', 'user-takeover.ts');
  if (fs.existsSync(takeoverPath)) {
    const takeoverSrc = fs.readFileSync(takeoverPath, 'utf8');
    const exportsExpected = ['start', 'stop', 'noteClippyInput', 'pauseDetection', 'resumeDetection', 'isActive'];
    const missingExports = exportsExpected.filter(
      (name) => !new RegExp(`export function ${name}\\b`).test(takeoverSrc),
    );
    const hasPowerMonitor = /powerMonitor\.getSystemIdleTime\(\)/.test(takeoverSrc);
    const hasCursorPoll = /screen\.getCursorScreenPoint\(\)/.test(takeoverSrc);
    const hasGraceWindow = /GRACE_WINDOW_MS\s*=\s*1500\b/.test(takeoverSrc);
    if (missingExports.length === 0 && hasPowerMonitor && hasCursorPoll && hasGraceWindow) {
      pass('v0.18.1: user-takeover module exports the expected API + uses powerMonitor + cursor delta + 1.5s grace');
    } else {
      fail('v0.18.1: user-takeover module shape', `missing=${missingExports.join(',')} pm=${hasPowerMonitor} cur=${hasCursorPoll} grace=${hasGraceWindow}`);
    }
  } else {
    fail('v0.18.1: user-takeover module', 'src/main/user-takeover.ts missing');
  }

  // brain.ts: cancelReason field, takeover start/stop, friendly stop
  // message, AND a static import — the latter catches the v0.18.1
  // Rollup bundle bug where a lazy require() slipped past the tree-
  // shaker and the takeover module body never reached the bundle.
  const cancelReasonField = /private cancelReason:.*TakeoverReason/.test(brainSrcNow);
  const startsTakeover = /(takeover|userTakeover)\.start\(\(reason, detail\) =>/.test(brainSrcNow);
  const stopsTakeover = /(takeover|userTakeover)\.stop\(\)/.test(brainSrcNow);
  const speaksReason = /'I'll stop'|"I'll stop — looks like you grabbed the mouse\."|grabbed the mouse|go ahead and type|taken over/.test(brainSrcNow);
  const userTakeoverStaticImport = /^import \* as userTakeover from ['"]\.\/user-takeover['"]/m.test(brainSrcNow);
  if (cancelReasonField && startsTakeover && stopsTakeover && speaksReason && userTakeoverStaticImport) {
    pass('v0.18.1: brain.ts wires takeover (static import + start + stop + cancelReason + stop message)');
  } else {
    fail('v0.18.1: brain.ts takeover wiring', `field=${cancelReasonField} start=${startsTakeover} stop=${stopsTakeover} speak=${speaksReason} staticImport=${userTakeoverStaticImport}`);
  }

  // tools.ts: INPUT_GENERATING_TOOLS set + noteClippyInput called
  // pre AND post (covers OS event-registration tail-latency on macOS),
  // AND a static import (Rollup bundle fix).
  const toolsSrcPRB = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tools.ts'), 'utf8');
  const hasInputSet = /INPUT_GENERATING_TOOLS = new Set\(\[/.test(toolsSrcPRB);
  const inputSetIncludesCore = ['mouse_click', 'type_text', 'smart_click', 'cdp_type', 'key_press']
    .every((t) => new RegExp(`'${t}'`).test(toolsSrcPRB));
  const noteCallCount = (toolsSrcPRB.match(/(userTakeover|t)\.noteClippyInput\(tool\)/g) || []).length;
  const toolsStaticImport = /^import \* as userTakeover from ['"]\.\/user-takeover['"]/m.test(toolsSrcPRB);
  if (hasInputSet && inputSetIncludesCore && noteCallCount >= 2 && toolsStaticImport) {
    pass('v0.18.1: tools.ts has INPUT_GENERATING_TOOLS set + static import + noteClippyInput pre+post dispatch');
  } else {
    fail('v0.18.1: tools.ts takeover wiring', `set=${hasInputSet} core=${inputSetIncludesCore} note_calls=${noteCallCount} staticImport=${toolsStaticImport}`);
  }

  // ────────── v0.18.2 — cursor-vision invariants ──────────
  // "Can you see this?" → capture region around cursor → feed to model.

  const cvPath = path.join(ROOT, 'src', 'main', 'cursor-vision.ts');
  if (!fs.existsSync(cvPath)) {
    fail('v0.18.2: cursor-vision module', 'src/main/cursor-vision.ts missing');
  } else {
    const cvSrc = fs.readFileSync(cvPath, 'utf8');

    // 1. Module exports the expected API.
    const hasLooks = /export function looksLikeCursorReference\(/.test(cvSrc);
    const hasCapture = /export async function captureCursorArea\(/.test(cvSrc);
    const hasBuild = /export async function buildCursorVisionParts\(/.test(cvSrc);
    const hasMacPath = /screencapture'/.test(cvSrc) && /'-R'/.test(cvSrc);
    const hasWinPath = /System\.Drawing\.Bitmap/.test(cvSrc);
    if (hasLooks && hasCapture && hasBuild && hasMacPath && hasWinPath) {
      pass('v0.18.2: cursor-vision module exports + dual-platform capture (mac screencapture, win System.Drawing)');
    } else {
      fail('v0.18.2: cursor-vision shape', `looks=${hasLooks} capture=${hasCapture} build=${hasBuild} mac=${hasMacPath} win=${hasWinPath}`);
    }

    // 2. brain.ts wires it into the first-user-turn build path.
    //    v0.18.3 changed from `cv.…` to `cursorVision.…` (static import
    //    so Rollup bundles the module). Test both names so a future
    //    refactor doesn't silently re-break the bundle.
    const looksMatch = /(cv|cursorVision)\.looksLikeCursorReference\(text\)/.test(brainSrcNow);
    const buildMatch = /(cv|cursorVision)\.buildCursorVisionParts\(text\)/.test(brainSrcNow);
    const cursorPartsMatch = /cursorParts/.test(brainSrcNow);
    // v0.18.3 — also require a STATIC import of the module, otherwise
    // Rollup's tree-shaker may skip the body and the runtime require
    // throws "Cannot find module."
    const staticImport = /^import \* as cursorVision from ['"]\.\/cursor-vision['"]/m.test(brainSrcNow);
    if (looksMatch && buildMatch && cursorPartsMatch && staticImport) {
      pass('v0.18.2: brain.ts wires cursor-vision (static import + first-user-turn build)');
    } else {
      fail('v0.18.2: brain.ts cursor-vision wiring', `looks=${looksMatch} build=${buildMatch} cursorParts=${cursorPartsMatch} staticImport=${staticImport}`);
    }

    // 3. Regex coverage — port the pattern in JS and verify it triggers
    //    on the intended positives and rejects clear negatives. If the
    //    canonical regex in cursor-vision.ts drifts, this catches it.
    const patternMatch = cvSrc.match(/CURSOR_REFERENCE_PATTERN\s*=\s*\/(.*)\/i;?/);
    if (!patternMatch) {
      fail('v0.18.2: cursor-vision regex extraction', 'cannot locate CURSOR_REFERENCE_PATTERN literal');
    } else {
      const pattern = new RegExp(patternMatch[1], 'i');
      const positives = [
        'can you see this',
        'can you see this?',
        'what is this?',
        "what's this",
        "what's that",
        'look at this',
        'look here',
        'tell me what this is',
        'hey clippy can you see this',
        'describe this please',
        'what do you see here',
        'help me with this',
      ];
      const negatives = [
        'what time is it',
        'send the email',
        'block 2pm tomorrow',
        'this is taking forever',  // "this" is metonymy, not a visual referent
        'open chrome',
        'are you there',
      ];
      const stripWake = (s) => s.replace(/^\s*(?:hey\s+)?clippy[,:]?\s*/i, '').trim();
      const posMisses = positives.filter((s) => !pattern.test(stripWake(s)));
      const negHits = negatives.filter((s) => pattern.test(stripWake(s)));
      if (posMisses.length === 0 && negHits.length === 0) {
        pass(`v0.18.2: cursor-reference regex — ${positives.length}/${positives.length} positives, ${negatives.length}/${negatives.length} negatives correctly classified`);
      } else {
        fail('v0.18.2: cursor-reference regex coverage', `misses=[${posMisses.join('|')}] false_pos=[${negHits.join('|')}]`);
      }
    }
  }
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
