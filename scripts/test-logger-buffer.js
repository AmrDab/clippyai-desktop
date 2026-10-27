/**
 * scripts/test-logger-buffer.js — behavioral tests for the buffered logger.
 *
 * Proves the v0.20.0 perf change (buffer-and-flush + off-hot-path rotate)
 * preserves correctness:
 *   (a) many rapid log calls are BATCHED (not one write per call) yet ALL
 *       content is present and PII-scrubbed after a flush;
 *   (b) rotation still triggers when the size threshold is crossed;
 *   (c) a forced flush (the same path used on process exit) writes the
 *       pending lines that were still sitting in the buffer.
 *
 * logger.ts imports 'electron' and derives LOG_DIR/PII patterns from
 * os.homedir()/os.userInfo() at module-load time. We can't `require` the .ts
 * directly in this CJS runner, so we transpile it with esbuild and evaluate it
 * in a sandbox whose `require` returns:
 *   - a stub `electron` (app.isPackaged = false → DEBUG level so every line
 *     we emit is recorded),
 *   - a patched `os` (homedir/userInfo point at a throwaway temp dir + a known
 *     username/home so we can assert PII scrubbing),
 *   - the real fs/path everywhere else.
 *
 * Run: node scripts/test-logger-buffer.js
 * Exits non-zero on any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const esbuild = require('esbuild');

// Bind to the real stdout up-front; the logger-under-test reassigns global
// console.* to mirror lines, and we mute those (see muteConsole) — but our own
// reporter must always reach the terminal, so write directly.
const out = (s) => process.stdout.write(s + '\n');

let passed = 0;
let failed = 0;
const failures = [];
function pass(name) { out(`  \x1b[32m[PASS]\x1b[0m ${name}`); passed++; }
function fail(name, reason) { out(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}`); failed++; failures.push(`${name}: ${reason}`); }
function header(name) { out(`\n=== ${name} ===`); }

const ROOT = path.resolve(__dirname, '..');
const LOGGER_TS = path.join(ROOT, 'src', 'main', 'logger.ts');

// The logger mirrors every line to console (dev convenience). Silence that
// noise during the test so only our PASS/FAIL lines show (we write those via
// `out` straight to stdout). Restore on the way out.
const _origLog = console.log, _origWarn = console.warn, _origErr = console.error;
function muteConsole() { console.log = console.warn = console.error = () => {}; }
function unmuteConsole() { console.log = _origLog; console.warn = _origWarn; console.error = _origErr; }

// ── Sandbox harness ─────────────────────────────────────────────────
// Fake home so LOG_DIR = <fakeHome>/.clippyai/logs and PII scrubbing has a
// known username/home to redact.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-logtest-'));
const FAKE_USER = 'sekretuser';

// Records every synchronous flush (fs.appendFileSync) the logger performs.
// The buffered logger drains via appendFileSync, so counting these calls is
// our direct evidence that N rapid log() calls coalesce into far fewer disk
// writes.
const appendCalls = [];

/**
 * Load logger.ts fresh into an isolated sandbox. Returns the module's exports
 * plus the LOG_DIR it computed so the test can read the file back.
 */
function loadLogger() {
  const src = fs.readFileSync(LOGGER_TS, 'utf8');
  const { code } = esbuild.transformSync(src, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2020',
    sourcefile: LOGGER_TS,
  });

  // Patched os: known home + username; everything else is the real os.
  const osStub = Object.assign(Object.create(os), {
    homedir: () => FAKE_HOME,
    userInfo: () => ({ ...os.userInfo(), username: FAKE_USER }),
  });

  // Wrap fs.appendFileSync so we can count flush calls (proves batching).
  const fsStub = Object.assign(Object.create(fs), {
    appendFileSync: (file, data, ...rest) => {
      appendCalls.push(typeof data === 'string' ? data : String(data));
      return fs.appendFileSync(file, data, ...rest);
    },
  });

  const electronStub = { app: { isPackaged: false } };

  const sandboxRequire = (id) => {
    if (id === 'electron') return electronStub;
    if (id === 'os') return osStub;
    if (id === 'fs') return fsStub;
    return Module.createRequire(LOGGER_TS)(id);
  };

  const moduleObj = { exports: {} };
  const wrapper = vm.compileFunction(
    code,
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename: LOGGER_TS },
  );
  wrapper(moduleObj.exports, sandboxRequire, moduleObj, LOGGER_TS, path.dirname(LOGGER_TS));
  const exp = moduleObj.exports;
  const LOG_DIR = exp.getLogDir();
  return { exp, LOG_DIR };
}

function logFilePath(LOG_DIR) {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `clippy-${date}.log`);
}

// small async sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  header('Logger buffer-and-flush — behavioral tests');

  muteConsole(); // hush the logger's own console mirroring for the duration
  const { exp, LOG_DIR } = loadLogger();
  const logFile = logFilePath(LOG_DIR);
  // Clean slate
  try { fs.rmSync(logFile, { force: true }); } catch {}

  // ── (a) Batching + completeness + PII scrubbing ──────────────────
  {
    appendCalls.length = 0;
    const log = exp.createLogger('buftest');
    const N = 50;
    for (let i = 0; i < N; i++) {
      // Each line embeds the fake home path + username + an email — all of
      // which MUST be redacted by scrubPII in the persisted line.
      log.info(`line ${i}`, { path: `${FAKE_HOME}/secret/file`, who: FAKE_USER, mail: 'a@b.com' });
    }

    // Before any flush: NOTHING should have hit disk yet — all N lines are
    // sitting in the in-memory buffer (the per-call hot path is zero-I/O).
    const writesBeforeFlush = appendCalls.length;
    if (writesBeforeFlush === 0) pass(`batching: ${N} info() calls produced 0 disk writes before flush (all buffered)`);
    else fail('batching', `expected 0 disk writes before flush, got ${writesBeforeFlush}`);

    // Now let the 250ms timer fire (we wait a bit longer to be safe).
    await sleep(400);

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    // All N lines present.
    const allPresent = Array.from({ length: N }, (_, i) => `"msg":"line ${i}"`).every((m) => content.includes(m));
    if (lines.length >= N && allPresent) pass(`completeness: all ${N} lines present after flush (${lines.length} total lines)`);
    else fail('completeness', `lines=${lines.length}, allPresent=${allPresent}`);

    // PII scrubbed in the persisted bytes.
    const noHome = !content.includes(FAKE_HOME);
    const noUser = !content.includes(FAKE_USER);
    const noEmail = !content.includes('a@b.com');
    const hasRedactions = content.includes('~') && content.includes('<user>') && content.includes('<email>');
    if (noHome && noUser && noEmail && hasRedactions) {
      pass('PII scrub: home→~, username→<user>, email→<email> applied to every buffered line');
    } else {
      fail('PII scrub', `noHome=${noHome}, noUser=${noUser}, noEmail=${noEmail}, redactions=${hasRedactions}`);
    }

    // Batching efficiency: the timer flush should coalesce all N lines into a
    // single appendFileSync (one disk write for the whole burst).
    if (appendCalls.length >= 1 && appendCalls.length < N) pass(`coalescing: ${N} log calls → ${appendCalls.length} disk write(s) after flush (batched)`);
    else fail('coalescing', `expected 1..<${N} disk writes, got ${appendCalls.length}`);
  }

  // ── (b) Rotation still triggers when size threshold crossed ──────
  {
    // Seed the current log file with > 5MB (MAX_LOG_SIZE) so the next rotate
    // check archives it to .1 and opens a fresh file. We don't want to emit
    // 5MB of real logs; pre-seeding the file exercises the real MAX_LOG_SIZE
    // constant + the real rename chain.
    const log = exp.createLogger('rottest');
    log.info('pre-rotate marker'); // ensure stream is open + path set
    await sleep(400); // flush it

    // Inflate the live log file past the 5MB threshold.
    const big = Buffer.alloc(6 * 1024 * 1024, 0x61); // 6MB of 'a'
    fs.appendFileSync(logFile, big);

    const rotatedPath = `${logFile}.1`;
    try { fs.rmSync(rotatedPath, { force: true }); } catch {}

    // Emit one more line, then force the flush+rotate path (this is exactly
    // what the 30s rotate interval / exit flush does in production).
    log.info('post-threshold line');
    exp.flushLogs(); // forces flushBuffer() + forced rotate check

    const rotatedExists = fs.existsSync(rotatedPath);
    const rotatedIsBig = rotatedExists && fs.statSync(rotatedPath).size > 5 * 1024 * 1024;
    if (rotatedExists && rotatedIsBig) pass(`rotation: file > MAX_LOG_SIZE archived to ${path.basename(rotatedPath)} (${(fs.statSync(rotatedPath).size / 1048576).toFixed(1)}MB)`);
    else fail('rotation', `rotatedExists=${rotatedExists}, rotatedIsBig=${rotatedIsBig}`);

    // After rotation the logger re-points at a fresh (lazily-created) file.
    // Emit + flush one more line; it must land in a NEW small file, proving
    // the archive freed the active path rather than re-appending to the 6MB
    // file.
    log.info('post-rotate fresh line');
    exp.flushLogs();
    const freshExists = fs.existsSync(logFile);
    const freshContent = freshExists ? fs.readFileSync(logFile, 'utf8') : '';
    const freshSmall = freshExists && fs.statSync(logFile).size < 5 * 1024 * 1024;
    const freshHasLine = freshContent.includes('post-rotate fresh line');
    if (freshExists && freshSmall && freshHasLine) pass('rotation: fresh log file opened after archive (new small file receives subsequent lines)');
    else fail('rotation: fresh file', `exists=${freshExists}, small=${freshSmall}, hasLine=${freshHasLine}`);
  }

  // ── (c) Forced flush (exit path) writes pending lines ────────────
  {
    // Write lines but do NOT wait for the 250ms timer — immediately call the
    // same flush the process 'exit'/'beforeExit' handlers use. The lines must
    // be on disk synchronously, proving no logs are lost on crash/quit.
    const log = exp.createLogger('exittest');
    const before = fs.readFileSync(logFile, 'utf8');
    log.info('crash-pending-1');
    log.info('crash-pending-2');

    // Sanity: these should still be buffered (timer hasn't fired).
    const midContent = fs.readFileSync(logFile, 'utf8');
    const notYetOnDisk = !midContent.includes('crash-pending-1') && midContent === before;

    exp.flushLogs(); // == the exit-time synchronous drain

    const after = fs.readFileSync(logFile, 'utf8');
    const nowOnDisk = after.includes('crash-pending-1') && after.includes('crash-pending-2');
    if (notYetOnDisk && nowOnDisk) {
      pass('flush-on-exit: pending lines were buffered, then written synchronously by forced flush');
    } else {
      fail('flush-on-exit', `notYetOnDisk=${notYetOnDisk}, nowOnDisk=${nowOnDisk}`);
    }

    // ── ERROR flushes promptly (no 250ms wait) ─────────────────────
    const preErr = fs.readFileSync(logFile, 'utf8').length;
    log.error('boom-this-explains-the-crash');
    // No sleep — error() must have flushed synchronously.
    const postErr = fs.readFileSync(logFile, 'utf8');
    if (postErr.includes('boom-this-explains-the-crash') && postErr.length > preErr) {
      pass('error-flush: ERROR-level line hits disk immediately (not stuck in 250ms buffer)');
    } else {
      fail('error-flush', 'ERROR line not flushed synchronously');
    }
  }

  // Cleanup temp dir
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}

  unmuteConsole();
  out(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    out('\nFAILURES:');
    failures.forEach((f) => out(`  - ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { unmuteConsole(); console.error(e); process.exit(1); });
