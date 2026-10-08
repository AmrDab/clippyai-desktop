// Window.clippy types live in src/preload/api.d.ts (single source of truth).
import { firstWinsForPlan } from './app-catalog';
import { PermissionFlow, type PermSnapshot, type PermKind } from './permission-flow';

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

const LICENSE_REGEX = /^CLIPPY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const TRY_IT_PROMPT = "What's on my screen?";

let currentStep = 1;
let validatedPlan = '';
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
  if (kbd) kbd.textContent = IS_MAC ? '⌘⇧Space' : 'Ctrl+Shift+Space';
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
  if (currentStep === 1) {
    const key = licenseInput.value.trim().toUpperCase();
    licenseError.textContent = '';

    // Step 1's footer Next is the "I pasted a key" path. If the field is
    // empty, nudge the user toward the free button rather than throwing a
    // format error — free is the primary path.
    if (!key) {
      licenseError.textContent = 'Enter your license key, or tap "Use Clippy free" above.';
      return;
    }

    if (!LICENSE_REGEX.test(key)) {
      licenseError.textContent = 'Invalid format. Expected: CLIPPY-XXXX-XXXX-XXXX';
      return;
    }

    btnNext.disabled = true;
    btnNext.textContent = 'Validating...';

    try {
      const result = await window.clippy.validateLicense(key);
      if (result.valid) {
        validatedPlan = result.plan;
        licenseInput.value = key;
        showStep(2);
      } else if ((result as { reason?: string }).reason === 'unreachable') {
        licenseError.textContent = "Couldn't reach our validation server. Check your connection and try again — your key isn't necessarily wrong.";
      } else {
        licenseError.textContent = 'Invalid license key. Please check and try again.';
      }
    } catch {
      licenseError.textContent = 'Could not validate. Check your internet connection.';
    } finally {
      btnNext.disabled = false;
      if (currentStep === 1) btnNext.textContent = 'Next';
    }
    return;
  }

  if (currentStep === 2) {
    // Persist license + buddy + voice on transition out of Meet Clippy so
    // the user's identity is committed BEFORE Clippy appears for Try it.
    const buddyName = buddyNameInput.value.trim() || 'Clippy';
    const ttsVoice = voiceSelect.value;
    const key = licenseInput.value.trim().toUpperCase();

    btnNext.disabled = true;
    btnNext.textContent = 'Saving...';

    try {
      await window.clippy.saveLicense(key, validatedPlan, buddyName, ttsVoice);
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

// Auto-uppercase license input. (The free/paid sections stay visible —
// they're distinct paths, not a fallback that hides when a key is typed.)
licenseInput.addEventListener('input', () => {
  const pos = licenseInput.selectionStart;
  licenseInput.value = licenseInput.value.toUpperCase();
  licenseInput.setSelectionRange(pos, pos);
});

// ── One-click activation (clippyai://activate from the email button) ──
// Main redeems the token and saves the license before telling us; on ok we
// carry the key + plan into the same step-2 save path as a pasted key.
window.clippy.onActivationResult((r) => {
  if (r.ok) {
    validatedPlan = r.plan || 'free';
    if (r.licenseKey) licenseInput.value = r.licenseKey;
    licenseError.textContent = '';
    if (currentStep === 1) showStep(2);
    return;
  }
  if (currentStep === 1) {
    licenseError.textContent = r.message || 'That activation link didn\'t work. Paste the key from your email instead.';
    licenseInput.focus();
  }
});

// ── Primary path: free signup (email → activation link + key, no card) ─
const btnUseFree = document.getElementById('btn-use-free') as HTMLButtonElement;
const freeEmailRow = document.getElementById('free-email-row')!;
const freeEmailInput = document.getElementById('free-email') as HTMLInputElement;
const btnFreeConfirm = document.getElementById('btn-free-confirm') as HTMLButtonElement;
const freeError = document.getElementById('free-error')!;

// Friendly copy for the error tokens the worker / preload can return.
function freeErrorMessage(code: string): string {
  switch (code) {
    case 'invalid_email': return "That email doesn't look right — double-check it and try again.";
    case 'rate_limited': return 'Too many attempts right now. Wait a minute, then try again — or paste a license key below.';
    case 'email_failed': return "We couldn't send the email. Try again in a moment — or paste a license key below.";
    case 'offline': return "Couldn't reach our server. Check your connection and try again — or paste a license key below.";
    default: return 'Something went wrong. Try again, or paste a license key below.';
  }
}

// Reveal the email field on first tap (the field replaces the button so the
// step still fits the window); Confirm submits.
btnUseFree.addEventListener('click', () => {
  freeError.textContent = '';
  btnUseFree.style.display = 'none';
  freeEmailRow.style.display = '';
  freeEmailInput.focus();
});

async function submitFreeSignup(): Promise<void> {
  const email = freeEmailInput.value.trim();
  freeError.textContent = '';
  if (!email) {
    freeError.textContent = 'Enter your email to continue.';
    freeEmailInput.focus();
    return;
  }
  // Cheap client-side format gate — mirrors the worker's lenient check so an
  // obviously-malformed address fails instantly instead of after a round-trip.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    freeError.textContent = freeErrorMessage('invalid_email');
    freeEmailInput.focus();
    return;
  }
  freeError.className = 'onboarding-error';
  btnFreeConfirm.disabled = true;
  btnFreeConfirm.textContent = 'Sending…';
  let emailed = false;
  try {
    const result = await window.clippy.freeSignup(email);
    if ('emailed' in result && result.emailed) {
      // The worker emailed an activation link + the key; neither comes back
      // over the wire. The email button opens clippyai://activate and we
      // advance from onActivationResult; pasting the key still works.
      emailed = true;
      freeError.className = 'onboarding-hint';
      freeError.textContent = 'Check your inbox and click the button in the email — or paste your key below.';
    } else {
      freeError.textContent = freeErrorMessage((result as { error: string }).error);
    }
  } catch {
    freeError.textContent = freeErrorMessage('offline');
  } finally {
    btnFreeConfirm.disabled = false;
    btnFreeConfirm.textContent = emailed ? 'Resend' : 'Confirm';
  }
}

btnFreeConfirm.addEventListener('click', submitFreeSignup);
freeEmailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void submitFreeSignup(); }
});
// A validation error shouldn't outlive the typo it describes; the
// "check your inbox" hint (onboarding-hint class) is not an error, keep it.
freeEmailInput.addEventListener('input', () => {
  if (freeError.className === 'onboarding-error') freeError.textContent = '';
});

// ── Paid plans → Stripe checkout in the browser ───────────────────────
// Neither plan has a trial — checkout charges immediately. Same links as
// settings.ts / main.ts (separate bundles); keep in sync if they rotate.
const STRIPE_POWER_URL = 'https://buy.stripe.com/8x2bJ06jXfC65XDe2Oe3e03'; // $19.99/mo
const STRIPE_MAX_URL = 'https://buy.stripe.com/5kQaEW7o1cpUdq52k6e3e05';   // $39.99/mo
const plansHint = document.getElementById('plans-hint')!;

for (const [id, url] of [['btn-get-power', STRIPE_POWER_URL], ['btn-get-max', STRIPE_MAX_URL]] as const) {
  document.getElementById(id)?.addEventListener('click', async () => {
    await window.clippy.openExternalUrl(url);
    plansHint.style.display = 'block';
    licenseInput.focus();
  });
}
