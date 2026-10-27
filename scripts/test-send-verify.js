/**
 * scripts/test-send-verify.js — unit test for classifyMessagesTree
 * (send confirmation via the accessibility tree, no screenshot / no FDA).
 *
 * Background: Clippy sends iMessages by keystroke (open_url(sms:…?body=…) →
 * key_press(Return)). key_press is in the brain's NEVER_CONFIRMS_SUCCESS set,
 * so the hallucination guard can't vouch for the send and used to tell the
 * user "key_press all failed" — even when the message went. classifyMessagesTree
 * reads the Messages AX tree instead: a body still in the compose field is an
 * un-sent draft; a body that's moved to a transcript bubble is a confirmed send.
 *
 * We transpile the REAL src/main/send-verify.ts with esbuild (it has zero
 * Electron deps by design) and exercise the actual exported function — not a
 * copy — so this guards production behavior, not a paraphrase of it.
 *
 * Run: node scripts/test-send-verify.js
 * Also invoked from scripts/smoke.js layer 1.
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadSendVerify() {
  const tsPath = path.join(ROOT, 'src', 'main', 'send-verify.ts');
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

// Compose input. Verified live on macOS Tahoe: it's a FOCUSED AXTextField
// pinned to the bottom of the window. The sms: URL pre-fills it; Return clears
// it. (text='' models a cleared box after a successful send.)
const composeWith = (text) => ({
  role: 'AXTextField',
  focused: true,
  value: text,
  children: [],
});
// A transcript message bubble. Verified live: these are NON-focused
// AXTextAreas (NOT AXStaticText) — same broad role family as the compose box,
// which is exactly why `focused` is the discriminator.
const bubbleWith = (text) => ({
  role: 'AXTextArea',
  focused: false,
  value: text,
  children: [],
});
const win = (...elements) => ({ elements });

// Exported so smoke.js layer 1 can roll these into the main totals.
function runSendVerifyTests(pass, fail) {
  let mod;
  try {
    mod = loadSendVerify();
  } catch (e) {
    fail('send-verify: module failed to transpile/load: ' + (e && e.message));
    return;
  }
  const { classifyMessagesTree } = mod;
  if (typeof classifyMessagesTree !== 'function') {
    fail('send-verify: classifyMessagesTree not exported as a function');
    return;
  }

  const check = (label, got, want) => {
    if (got === want) pass(`send-verify: ${label} → ${want}`);
    else fail(`send-verify: ${label} → expected ${want}, got ${got}`);
  };

  // 1. Draft still in the compose field → NOT sent. This is the case that used
  //    to be mislabeled "sent" by the model's optimistic claim.
  check('draft stuck in compose',
    classifyMessagesTree([win(composeWith('come over'))], 'come over'),
    'not_sent');

  // 2. Compose cleared, body now a transcript bubble → confirmed.
  check('compose cleared + bubble present',
    classifyMessagesTree([win(composeWith(''), bubbleWith('come over'))], 'come over'),
    'confirmed');

  // 3. Compose cleared, no bubble within read depth → unconfirmed (the draft is
  //    gone, which is strong evidence, but we don't claim proof).
  check('compose cleared, no bubble',
    classifyMessagesTree([win(composeWith(''))], 'come over'),
    'unconfirmed');

  // 4. SAFETY: same text in BOTH compose and a bubble (resend of identical
  //    text) must resolve to not_sent — never upgrade a stuck draft to success.
  check('same text in compose AND bubble → not_sent wins',
    classifyMessagesTree([win(composeWith('come over'), bubbleWith('come over'))], 'come over'),
    'not_sent');

  // 5. Match is case-insensitive and substring (caller lowercases the needle;
  //    bubbles often wrap the body in timestamps / "You:" prefixes).
  check('case-insensitive substring bubble match',
    classifyMessagesTree([win(bubbleWith('You: Come Over  9:41 PM'))], 'come over'),
    'confirmed');

  // 5b. EXACT live structure (macOS Tahoe, pid 23216 capture): empty focused
  //     AXTextField compose + the body sitting in a non-focused AXTextArea
  //     bubble → confirmed. This is the real-world case the old role mapping
  //     got WRONG (it read the AXTextArea bubble as a stuck draft).
  check('live Tahoe layout: empty compose + AXTextArea bubble',
    classifyMessagesTree([win(composeWith(''), bubbleWith('come'))], 'come'),
    'confirmed');

  // 5c. A focused AXTextArea draft (compose modeled as a text area on some
  //     versions) still holding the body → not_sent. `focused` carries it.
  check('focused AXTextArea draft → not_sent',
    classifyMessagesTree([win({ role: 'AXTextArea', focused: true, value: 'come over', children: [] })], 'come over'),
    'not_sent');

  // 6. Nested children are walked (Messages nests bubbles several levels deep).
  check('deeply nested bubble found',
    classifyMessagesTree(
      [win({ role: 'AXGroup', children: [{ role: 'AXGroup', children: [bubbleWith('come over')] }] })],
      'come over'),
    'confirmed');

  // 7. No windows (Messages not open / tree empty) → unknown, not a false deny.
  check('no windows → unknown', classifyMessagesTree([], 'come over'), 'unknown');
  check('undefined windows → unknown', classifyMessagesTree(undefined, 'come over'), 'unknown');

  // 8. Empty needle → unknown (guards against a too-short / stripped body).
  check('empty needle → unknown', classifyMessagesTree([win(bubbleWith('x'))], ''), 'unknown');

  // 9. Body absent entirely → unconfirmed (compose clear, nothing matched).
  check('body nowhere in tree → unconfirmed',
    classifyMessagesTree([win(composeWith('different draft'), bubbleWith('old msg'))], 'come over'),
    'unconfirmed');

  // 10. A FOCUSED AXComboBox compose surface (some locales/versions) holding
  //     the body → not_sent via the focused-editable path.
  check('focused combobox compose → not_sent',
    classifyMessagesTree([win({ role: 'AXComboBox', focused: true, value: 'come over', children: [] })], 'come over'),
    'not_sent');

  // 11. A non-focused AXTextField holding the body → not_sent via the role
  //     fallback (AXTextField is always the input box, never a bubble), even
  //     when focus state is absent from the tree.
  check('non-focused AXTextField (role fallback) → not_sent',
    classifyMessagesTree([win({ role: 'AXTextField', value: 'come over', children: [] })], 'come over'),
    'not_sent');
}

module.exports = { runSendVerifyTests };

// Standalone runner.
if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const pass = (m) => { passed++; console.log('  ✓ ' + m); };
  const fail = (m) => { failed++; console.error('  ✗ ' + m); };
  console.log('test-send-verify:');
  runSendVerifyTests(pass, fail);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
