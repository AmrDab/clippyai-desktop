// Window.clippy types live in src/preload/api.d.ts (single source of truth).
import { firstWinsForPlan } from './app-catalog';
import { PermissionFlow, type PermSnapshot, type PermKind } from './permission-flow';
import { VOICE_ACCELERATOR_DEFAULT, acceleratorLabel } from '../main/hotkey-defs';
import { normalizeCode, isCompleteCode, isValidEmail } from '../main/account-input';
import { suggestEmail, inboxLink } from '../main/email-suggest';
import { t, isLang, type Key, type Lang } from '../main/i18n';
import { accountErrorText, clearsCodeInput, needsNewCode, resendHoldSeconds, RESEND_COUNTDOWN_MAX_S } from '../main/account-copy';
import { EASE_OUT, DUR, reducedMotion } from './motion';
import { normalizeLicenseKey, keyLookalikes, lookalikeMessage, KEY_FORMAT_HINT, KEY_NOT_FOUND_MESSAGE } from './license-key';

// v0.19.0 PR-6 — Fluent Reveal effect. Any element marked with
// [data-fluent-reveal] gets a CSS radial-gradient highlight whose center
// follows the cursor. We set --reveal-x / --reveal-y as element-scoped
// custom properties; the CSS in style.css ([data-platform="win"]
// [data-fluent-reveal]::before) reads them. A single delegated listener on
// document so chips added at runtime pick up the effect.
function installFluentReveal(): void {
  document.addEventListener('mousemove', (e) => {
    const target = e.target as Element | null;
    if (!target) return;
    const el = target.closest('[data-fluent-reveal]') as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--reveal-x', `${e.clientX - r.left}px`);
    el.style.setProperty('--reveal-y', `${e.clientY - r.top}px`);
  });
}
installFluentReveal();

// Window URL carries lang (set by main).
const params = new URLSearchParams(location.search);
const LANG: Lang = isLang(params.get('lang')) ? (params.get('lang') as Lang) : 'en';
const T = (key: Key, vars?: Record<string, string | number>): string => t(LANG, key, vars);
document.documentElement.lang = LANG;
document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = T(el.dataset.i18n as Key); });
document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => { el.placeholder = T(el.dataset.i18nPlaceholder as Key); });
document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', T(el.dataset.i18nAria as Key)); });

const LICENSE_REGEX = /^CLIPPY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const TRY_IT_PROMPT = "What's on my screen?";

let currentStep = 1;
let validatedPlan = '';
// Set after a confirmed email code: main already holds the key + plan.
let licenseSavedInMain = false;
// Try it (step 4) state — see startTryIt / onTutorialEvent.
let tutorialStarted = false;
let tutorialAnswered = false;
// Set when Screen Recording is granted during the macOS walkthrough. The
// relaunch it needs is DEFERRED to the very end (the Finish button) so it
// never interrupts the rest of onboarding.
let permNeedsRelaunch = false;

const steps = document.querySelectorAll<HTMLElement>('.onboarding-step');
const dotsEl = document.querySelector<HTMLElement>('.progress-dots')!;
const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
const licenseInput = document.getElementById('license-key') as HTMLInputElement;
const licenseError = document.getElementById('license-error')!;
const buddyNameInput = document.getElementById('buddy-name') as HTMLInputElement;
const voiceSelect = document.getElementById('voice-select') as HTMLSelectElement;
const firstWinsEl = document.getElementById('first-wins-chips')!;
const tryItStatus = document.getElementById('tryit-status')!;

// v0.19.0 PR-6 — set data-platform so the Liquid Glass theme picks up.
// Feature-gated against navigator.platform so the shared tree renders mac
// vibrancy on macOS and the Fluent treatment on Windows.
const IS_MAC = (navigator.platform || '').toLowerCase().includes('mac');
(function setPlatform(): void {
  const p = (navigator.platform || '').toLowerCase();
  if (p.includes('mac')) document.body.setAttribute('data-platform', 'mac');
  else if (p.includes('win')) document.body.setAttribute('data-platform', 'win');
  else document.body.setAttribute('data-platform', 'other');
})();

// ── Step order ────────────────────────────────────────────────────────
// 1 Activate → 2 Meet Clippy → (3 Permissions, macOS only) → 4 Try it.
// Windows needs no per-app grants (the mac TCC APIs don't exist there), so
// the permissions step is dropped from the order AND from the dots.
const STEP_ORDER = IS_MAC ? [1, 2, 3, 4] : [1, 2, 4];
const LAST_STEP = 4;
function nextStep(step: number): number { return STEP_ORDER[STEP_ORDER.indexOf(step) + 1] ?? LAST_STEP; }
function prevStep(step: number): number { return STEP_ORDER[STEP_ORDER.indexOf(step) - 1] ?? 1; }

for (const step of STEP_ORDER) {
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.dataset.dot = String(step);
  dotsEl.appendChild(dot);
}
const dots = dotsEl.querySelectorAll<HTMLElement>('.dot');

function showStep(step: number): void {
  steps.forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.step) === step);
  });
  const idx = STEP_ORDER.indexOf(step);
  dots.forEach((dot) => {
    dot.classList.toggle('active', STEP_ORDER.indexOf(Number(dot.dataset.dot)) <= idx);
  });

  // No Back once the tutorial has started — Clippy is already live.
  // Step 1 is the email/code screen: no wizard footer, only the × button.
  document.querySelector<HTMLElement>('.onboarding-footer')!.style.display = step === 1 ? 'none' : '';
  document.getElementById('setup-close')!.style.display = step === 1 ? '' : 'none';
  btnBack.style.visibility = step > 1 && step !== LAST_STEP ? 'visible' : 'hidden';
  // Try it: the footer button is an escape hatch ("Skip") until Clippy has
  // answered the first ask, then it becomes "Finish" (see onTutorialEvent).
  btnNext.textContent = step === LAST_STEP ? (tutorialAnswered ? 'Finish' : 'Skip') : 'Next';
  // Step 3 (permission walkthrough) drives itself via the in-card Open/Skip
  // controls + auto-advance; hide the footer Next so it can't bypass the
  // remaining permissions. The in-card "Skip for now" always advances.
  btnNext.style.visibility = step === 3 ? 'hidden' : 'visible';

  // If Screen Recording was granted during setup, surface the restart as an
  // explicit choice (Quit & Reopen / Later) instead of forcing a quit.
  const relaunchBanner = document.getElementById('relaunch-banner');
  if (relaunchBanner) {
    const showBanner = step === LAST_STEP && permNeedsRelaunch;
    relaunchBanner.hidden = !showBanner;
    if (showBanner) btnNext.style.visibility = 'hidden';
  }

  currentStep = step;

  if (step === 2) populateVoices();
  if (step === 3) void startPermWalkthrough();
  else stopPolling();
  if (step === LAST_STEP) void startTryIt();
}

function populateVoices(): void {
  const voices = window.speechSynthesis.getVoices();
  voiceSelect.innerHTML = '';
  const englishVoices = voices.filter((v) => v.lang.startsWith('en'));
  const list = englishVoices.length > 0 ? englishVoices : voices;

  for (const voice of list) {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = `${voice.name} (${voice.lang})`;
    voiceSelect.appendChild(opt);
  }
}

// Pre-populate voices
window.speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();

// ── Step 4: Try it ────────────────────────────────────────────────────
// Clippy is shown + the brain woken WITHOUT closing this window, so the
// user's first ask happens with the instructions still on screen. Main
// tags those turns `onboarding: true` (not billed) until we finish.

async function startTryIt(): Promise<void> {
  const kbd = document.getElementById('tryit-hotkey');
  if (kbd) kbd.textContent = acceleratorLabel(VOICE_ACCELERATOR_DEFAULT, IS_MAC ? 'mac' : 'win');
  renderFirstWins();
  if (tutorialStarted) return;
  tutorialStarted = true;
  tryItStatus.textContent = 'Waiting for your first ask…';
  try { await window.clippy.startTutorial(); } catch { /* main logs */ }
}

function renderFirstWins(): void {
  firstWinsEl.innerHTML = '';
  for (const chip of firstWinsForPlan(validatedPlan)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'first-win-chip';
    btn.textContent = chip.label;
    btn.addEventListener('click', () => { void fireTutorialPrompt(chip.prompt); });
    firstWinsEl.appendChild(btn);
  }
}

// Typed fallback + chips route through first-win-chip: main pumps the text
// to the bubble, which sends it exactly like a typed message.
async function fireTutorialPrompt(prompt: string): Promise<void> {
  try { await window.clippy.fireFirstWinChip?.(prompt); } catch { /* main logs */ }
}

document.getElementById('btn-tryit-type')?.addEventListener('click', () => { void fireTutorialPrompt(TRY_IT_PROMPT); });

window.clippy.onTutorialEvent((ev) => {
  if (currentStep !== LAST_STEP) return;
  if (ev === 'started') {
    if (!tutorialAnswered) tryItStatus.textContent = "Clippy's on it…";
  } else if (ev === 'answered') {
    tutorialAnswered = true;
    tryItStatus.textContent = "That's it — you're all set. Ask anything, any time.";
    btnNext.textContent = 'Finish';
  }
});

// Idempotent so every exit path (Finish / Skip / relaunch) can call it.
let onboardingFinished = false;
async function finishOnboarding(): Promise<void> {
  if (onboardingFinished) return;
  onboardingFinished = true;
  try { await window.clippy.finishOnboarding(); } catch { /* main logs */ }
}

// ── Step 3: Permission walkthrough (macOS) ────────────────────────────
// Clippy walks the user through the macOS permission prompts one at a time.
// The pure state machine lives in permission-flow.ts; this code owns the
// IPC calls and the poll loop that detects a freshly-granted permission.

let permFlow: PermissionFlow | null = null;
let permPollTimer: number | null = null;
// Tracks which permission the card currently shows, so we only replay the
// card re-entrance animation (.perm-enter) when a NEW permission appears.
let lastPermKind: string | null = null;
let permStarting = false;

async function permSnapshot(): Promise<PermSnapshot> {
  const p = await window.clippy.getPermissions?.();
  return {
    accessibility: p?.accessibility === 'granted',
    screenRecording: p?.screenRecording === 'granted',
    automationAnyBrowser: Object.values(p?.automation ?? {}).some((v) => v === 'granted'),
  };
}

function renderPerm(state: ReturnType<PermissionFlow['current']>): void {
  if (state.done) { stopPolling(); showStep(nextStep(3)); return; }
  const why = document.getElementById('perm-why');
  const status = document.getElementById('perm-status');
  const open = document.getElementById('perm-open') as HTMLButtonElement | null;
  const card = document.getElementById('perm-card');
  // Gentle re-entrance whenever a NEW permission appears (CSS .perm-enter).
  if (card && state.kind !== lastPermKind) {
    card.classList.remove('perm-enter');
    void card.offsetWidth; // reflow so the animation restarts
    card.classList.add('perm-enter');
    lastPermKind = state.kind;
  }
  if (why) why.textContent = permFlow!.why(state.kind as PermKind);
  if (status) {
    status.textContent = state.status === 'granted'
      ? 'Granted ✓'
      : state.status === 'waiting' || state.status === 'opened'
        ? 'Waiting…'
        : 'Needed';
    status.classList.toggle('granted', state.status === 'granted');
  }
  if (open) open.style.display = (state.status === 'waiting' || state.status === 'opened') ? 'none' : '';
  // Defer the Screen-Recording relaunch to the END of onboarding (the relaunch
  // banner) — restarting mid-flow skipped the remaining steps. Just record here.
  if (state.needsRelaunch) permNeedsRelaunch = true;
  if (card) card.classList.toggle('perm-granted', state.status === 'granted');
}

async function startPermWalkthrough(): Promise<void> {
  if (permStarting) return;
  permStarting = true;
  try {
  // Only the two permissions macOS can grant UPFRONT from System Settings.
  // Automation is intentionally NOT here: macOS won't list an app in the
  // Automation privacy pane until it first tries to control another app, so
  // there's nothing to toggle during onboarding. Clippy requests Automation
  // lazily — the standard "Allow ClippyAI to control Safari?" dialog appears
  // the first time he drives a browser. Screen Recording stays LAST (its
  // relaunch is deferred to the Finish button).
  permFlow = new PermissionFlow(['accessibility', 'screenRecording'], { hasBrowser: false });
  lastPermKind = null; // force the first bubble to spring out on start
  renderPerm(permFlow.start(await permSnapshot()));

  const openBtn = document.getElementById('perm-open');
  const skipBtn = document.getElementById('perm-skip');
  if (openBtn) {
    openBtn.onclick = async () => {
      const kind = permFlow!.current().kind as PermKind;
      // Screen recording needs the in-app request first to register the app in
      // the TCC list before the pane is useful.
      if (kind === 'screenRecording') await window.clippy.requestScreenRecording?.();
      await window.clippy.openPermissionPane?.(kind);
      renderPerm(permFlow!.open());
      startPolling();
    };
  }
  if (skipBtn) {
    skipBtn.onclick = () => { stopPolling(); renderPerm(permFlow!.skip()); };
  }
  } finally {
    permStarting = false;
  }
}

function startPolling(): void {
  stopPolling();
  permPollTimer = window.setInterval(async () => {
    const s = permFlow!.onSnapshot(await permSnapshot());
    renderPerm(s);
    if (s.justGranted) {
      stopPolling();
      // Brief beat on the Congratulate animation before moving on.
      setTimeout(() => renderPerm(permFlow!.advance()), 1000);
    }
  }, 1500);
}

function stopPolling(): void {
  if (permPollTimer !== null) {
    clearInterval(permPollTimer);
    permPollTimer = null;
  }
}

// ── Navigation ────────────────────────────────────────────────────────

btnNext.addEventListener('click', async () => {
  if (currentStep === 2) {
    // Persist license + buddy + voice on transition out of Meet Clippy so
    // the user's identity is committed BEFORE Clippy appears for Try it.
    const buddyName = buddyNameInput.value.trim() || 'Clippy';
    const ttsVoice = voiceSelect.value;
    const key = licenseInput.value.trim().toUpperCase();

    btnNext.disabled = true;
    btnNext.textContent = 'Saving...';

    try {
      // A code sign-in already stored the key in main (it never reaches this
      // window); a pasted key is saved here.
      if (licenseSavedInMain) await window.clippy.savePersona(buddyName, ttsVoice);
      else await window.clippy.saveLicense(key, validatedPlan, buddyName, ttsVoice);
      // v0.19.0 PR-6.3 — commit launch-on-startup pick from the onboarding
      // toggle. Best-effort; main idempotently updates the login item, so
      // a failure here just leaves the OS default (no auto-launch) and the
      // user can flip it later in Settings.
      const launchToggle = document.getElementById('onboarding-launch-startup') as HTMLInputElement | null;
      const launchOnStartup = launchToggle ? launchToggle.checked : true;
      try {
        await window.clippy.setLaunchOnStartup(launchOnStartup);
      } catch { /* non-fatal; main logs */ }
      showStep(nextStep(2));
    } catch {
      btnNext.textContent = 'Next';
    } finally {
      btnNext.disabled = false;
    }
    return;
  }

  if (currentStep === LAST_STEP) {
    // Finish / Skip: run the post-onboarding prompts, then close. The
    // Screen-Recording relaunch is a separate explicit choice via the banner.
    await finishOnboarding();
    window.close();
  }
});

btnBack.addEventListener('click', () => {
  if (currentStep > 1) showStep(prevStep(currentStep));
});

// Relaunch banner — explicit Screen-Recording restart choice. "Quit & Reopen"
// applies SR immediately; "Later" just closes onboarding and lets SR take
// effect on Clippy's next launch.
document.getElementById('btn-relaunch-now')?.addEventListener('click', async () => {
  await finishOnboarding();
  void window.clippy.restartApp?.();
});
document.getElementById('btn-relaunch-later')?.addEventListener('click', async () => {
  await finishOnboarding();
  window.close();
});

// ── Paste a license key (old emails / other devices) ──────────────────
// Hidden behind "I have a license key"; Activate (or Enter) validates.
const btnKeyLink = document.getElementById('btn-key-link') as HTMLButtonElement;
const keyRow = document.getElementById('key-row')!;
const btnKeyActivate = document.getElementById('btn-key-activate') as HTMLButtonElement;

btnKeyLink.addEventListener('click', () => {
  keyRow.hidden = false;
  btnKeyLink.hidden = true;
  licenseInput.focus();
});

async function activateKey(): Promise<void> {
  const key = normalizeLicenseKey(licenseInput.value);
  if (key) licenseInput.value = key; // show the cleaned-up key
  licenseError.textContent = '';
  if (!key) return;

  if (!LICENSE_REGEX.test(key)) {
    licenseError.textContent = `That doesn't look like a Clippy key. ${KEY_FORMAT_HINT} You can also just click Activate in the email.`;
    return;
  }
  const lookalikes = keyLookalikes(key);
  if (lookalikes.length) {
    licenseError.textContent = lookalikeMessage(lookalikes);
    return;
  }

  btnKeyActivate.disabled = true;
  try {
    const result = await window.clippy.validateLicense(key);
    if (result.valid) {
      validatedPlan = result.plan;
      licenseInput.value = key;
      if (!IS_MAC) {
        // Windows: no wizard after sign-in. Save the key and go to Clippy.
        await window.clippy.saveLicense(key, result.plan, 'Clippy', '');
        await finishFirstRun();
      } else {
        showStep(2);
      }
    } else if ((result as { reason?: string }).reason === 'unreachable') {
      licenseError.textContent = "Couldn't reach our validation server. Check your connection and try again — your key isn't necessarily wrong.";
    } else {
      licenseError.textContent = KEY_NOT_FOUND_MESSAGE;
    }
  } catch {
    licenseError.textContent = 'Could not validate. Check your internet connection.';
  } finally {
    btnKeyActivate.disabled = false;
  }
}

btnKeyActivate.addEventListener('click', () => { void activateKey(); });
// v0.21 — Enter in the key field validates, same as the Activate button.
licenseInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && !btnKeyActivate.disabled) {
    e.preventDefault();
    void activateKey();
  }
});

licenseInput.addEventListener('input', () => {
  const pos = licenseInput.selectionStart;
  licenseInput.value = licenseInput.value.toUpperCase();
  licenseInput.setSelectionRange(pos, pos);
});

/** Windows: signed in (code or key) -> straight to Clippy; the greeting + chips come from main. */
async function finishFirstRun(): Promise<void> {
  try { await window.clippy.onOnboardingComplete(); } catch { /* main logs */ }
  window.close();
}

// ── One-click activation (clippyai://activate from the email button) ──
// Main redeems the token and saves the license before telling us.
window.clippy.onActivationResult((r) => {
  if (r.ok) {
    validatedPlan = r.plan || 'free';
    licenseError.textContent = '';
    if (currentStep !== 1) return;
    if (!IS_MAC) { void finishFirstRun(); return; }
    if (r.licenseKey) licenseInput.value = r.licenseKey;
    showStep(2);
    return;
  }
  if (currentStep === 1) {
    keyRow.hidden = false;
    btnKeyLink.hidden = true;
    licenseError.textContent = r.message || "That activation link didn't work. Paste the key from your email instead.";
    licenseInput.focus();
  }
});

// ── Primary path: email → 6-digit code ────────────────────────────────
// Copy comes from i18n.ts; errors from account-copy.ts.
const emailStage = document.getElementById('email-stage')!;
const codeStage = document.getElementById('code-stage')!;
const setupEmail = document.getElementById('setup-email') as HTMLInputElement;
const setupCode = document.getElementById('setup-code') as HTMLInputElement;
const btnSendCode = document.getElementById('btn-send-code') as HTMLButtonElement;
const btnVerify = document.getElementById('btn-verify-code') as HTMLButtonElement;
const btnResendCode = document.getElementById('btn-resend-code') as HTMLButtonElement;
const btnChangeEmail = document.getElementById('btn-change-email') as HTMLButtonElement;
const btnOpenInbox = document.getElementById('btn-open-inbox') as HTMLButtonElement;
const btnEmailFix = document.getElementById('btn-email-fix') as HTMLButtonElement;
const emailSuggestEl = document.getElementById('email-suggest')!;
const emailSuggestText = document.getElementById('email-suggest-text')!;
const codeResentEl = document.getElementById('code-resent')!;
const setupError = document.getElementById('setup-error')!;
const codeLabel = document.getElementById('code-label')!;

let sentTo = '';
let sending = false;
let verifying = false;

function showSetupError(msg: string): void { setupError.textContent = msg; }
function codeDigits(): string { return normalizeCode(setupCode.value); }
function updateVerifyButton(): void { btnVerify.disabled = verifying || !isCompleteCode(codeDigits()); }

/** Forward enters from the right, back from the left. Only the entering stage moves. */
function enterStage(el: HTMLElement, dir: 1 | -1): void {
  if (reducedMotion()) return;
  el.animate(
    [{ opacity: 0, transform: `translateX(${8 * dir}px)` }, { opacity: 1, transform: 'none' }],
    { duration: DUR.base, easing: EASE_OUT },
  );
}

/** A rejected code shakes the field once (same cadence as the bubble's error shake). */
function rejectCode(): void {
  if (reducedMotion()) return;
  setupCode.animate(
    { transform: ['translateX(0)', 'translateX(-4px)', 'translateX(4px)', 'translateX(-2px)', 'translateX(2px)', 'translateX(0)'] },
    { duration: 320, easing: EASE_OUT },
  );
}

function showCodeStage(): void {
  window.clippy.trackOnboarding('code_screen_shown');
  emailStage.style.display = 'none';
  codeStage.style.display = '';
  enterStage(codeStage, 1);
  codeLabel.textContent = T('code.label', { email: sentTo });
  const inbox = inboxLink(sentTo);
  btnOpenInbox.hidden = !inbox;
  if (inbox) {
    btnOpenInbox.textContent = T(inbox.provider === 'gmail' ? 'code.open.gmail' : 'code.open.outlook');
    btnOpenInbox.onclick = () => { void window.clippy.openExternalUrl(inbox.url); };
  }
  setupCode.value = '';
  updateVerifyButton();
  setupCode.focus();
  holdResend(30);
}

/** "Send a new code" is locked while the server would refuse (30 s after a send, or its retry_after). */
let resendTimer: number | null = null;
function enableResend(): void {
  if (resendTimer !== null) { clearTimeout(resendTimer); resendTimer = null; }
  btnResendCode.disabled = false;
  btnResendCode.textContent = T('code.resend');
}
function holdResend(seconds: number): void {
  if (resendTimer !== null) { clearTimeout(resendTimer); resendTimer = null; }
  btnResendCode.disabled = true;
  if (seconds > RESEND_COUNTDOWN_MAX_S) {
    // Too long for a countdown: just locked until the server would accept again.
    btnResendCode.textContent = T('code.resend');
    resendTimer = window.setTimeout(enableResend, Math.min(seconds, 24 * 60 * 60) * 1000);
    return;
  }
  let left = seconds;
  const tick = () => {
    if (left <= 0) { enableResend(); return; }
    btnResendCode.textContent = T('code.resend.wait', { s: left });
    left -= 1;
    resendTimer = window.setTimeout(tick, 1000);
  };
  tick();
}

let resentTimer: number | null = null;
function flashResent(): void {
  codeResentEl.textContent = T('code.resent');
  if (resentTimer !== null) clearTimeout(resentTimer);
  resentTimer = window.setTimeout(() => { codeResentEl.textContent = ''; }, 4000);
}

async function sendCodeTo(email: string, resend: boolean): Promise<void> {
  if (sending) return;
  showSetupError('');
  if (!isValidEmail(email)) { showSetupError(T('err.invalid_email')); setupEmail.focus(); return; }
  sending = true;
  btnSendCode.disabled = true;
  btnSendCode.textContent = T('email.sending');
  if (resend) btnResendCode.disabled = true;
  try {
    const r = await window.clippy.sendCode(email);
    if (r.ok) {
      sentTo = email.trim();
      if (resend) { holdResend(30); flashResent(); } else showCodeStage();
    } else {
      showSetupError(accountErrorText(LANG, r));
      if (resend) holdResend(resendHoldSeconds(r));
    }
  } catch {
    showSetupError(T('err.offline'));
    if (resend) holdResend(5);
  } finally {
    sending = false;
    btnSendCode.disabled = false;
    btnSendCode.textContent = T('email.send');
  }
}

async function submitCode(): Promise<void> {
  const code = codeDigits();
  if (verifying || !isCompleteCode(code)) return;
  verifying = true;
  showSetupError('');
  btnVerify.textContent = T('code.checking');
  updateVerifyButton();
  setupCode.readOnly = true; // keeps focus, unlike disabled
  try {
    const r = await window.clippy.verifyCode(sentTo, code);
    if (r.ok) {
      licenseSavedInMain = true;
      validatedPlan = r.plan;
      // A short success beat before the window moves on.
      btnVerify.textContent = T('code.done');
      if (!reducedMotion()) await new Promise((res) => setTimeout(res, DUR.celebrate));
      if (!IS_MAC) await finishFirstRun(); // Windows: straight to Clippy
      else showStep(2);
      return;
    }
    showSetupError(accountErrorText(LANG, r));
    if (clearsCodeInput(r)) { setupCode.value = ''; rejectCode(); }
    if (needsNewCode(r)) enableResend();
    else if (r.error === 'rate_limited') holdResend(resendHoldSeconds(r));
  } catch {
    // Network trouble: keep the digits; Continue retries.
    showSetupError(T('err.offline'));
  } finally {
    verifying = false;
    setupCode.readOnly = false;
    btnVerify.textContent = T('code.continue');
    updateVerifyButton();
    if (currentStep === 1) setupCode.focus();
  }
}

// Typo hint under the email box; never blocks sending.
function showEmailSuggestion(): void {
  const fix = suggestEmail(setupEmail.value);
  emailSuggestEl.hidden = !fix;
  if (fix) {
    emailSuggestText.textContent = T('email.suggest', { email: fix });
    btnEmailFix.dataset.fix = fix;
  }
}

btnSendCode.addEventListener('click', () => { void sendCodeTo(setupEmail.value, false); });
setupEmail.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void sendCodeTo(setupEmail.value, false); }
});
setupEmail.addEventListener('input', () => { showSetupError(''); emailSuggestEl.hidden = true; });
setupEmail.addEventListener('blur', showEmailSuggestion);

btnEmailFix.addEventListener('click', () => {
  if (btnEmailFix.dataset.fix) setupEmail.value = btnEmailFix.dataset.fix;
  emailSuggestEl.hidden = true;
  setupEmail.focus();
});
btnResendCode.addEventListener('click', () => { window.clippy.trackOnboarding('resend_clicked'); void sendCodeTo(sentTo, true); });
btnChangeEmail.addEventListener('click', () => {
  showSetupError('');
  codeResentEl.textContent = '';
  codeStage.style.display = 'none';
  emailStage.style.display = '';
  enterStage(emailStage, -1);
  setupEmail.focus();
});
// Digits only (typed or pasted, " 123 456" included); the sixth digit submits by itself.
setupCode.addEventListener('input', () => {
  setupCode.value = codeDigits();
  showSetupError('');
  updateVerifyButton();
  if (isCompleteCode(setupCode.value) && !sending) void submitCode();
});
setupCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void submitCode(); }
});
btnVerify.addEventListener('click', () => { void submitCode(); });

// ── Closing the setup window ──────────────────────────────────────────
// × and Esc work on step 1; the app stays in the tray and the
// license is untouched. (The header is the drag handle, see style.css.)
const btnClose = document.getElementById('setup-close') as HTMLButtonElement;
btnClose.addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentStep === 1) window.close();
});

// Funnel: the email box has focus (main sends each step once).
setupEmail.addEventListener('focus', () => window.clippy.trackOnboarding('email_focused'), { once: true });
setupEmail.focus();
