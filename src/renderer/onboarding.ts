// Window.clippy types live in src/preload/api.d.ts (single source of truth).
import { APP_CATALOG, APP_BY_ID, FIRST_WINS, type AppCatalogEntry } from './app-catalog';
import { PermissionFlow, type PermSnapshot, type PermKind } from './permission-flow';

const LICENSE_REGEX = /^CLIPPY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

let currentStep = 1;
let validatedPlan = '';
const selectedAppIds = new Set<string>();
const pendingApiTokens = new Map<string, string>(); // appId → token

const steps = document.querySelectorAll<HTMLElement>('.onboarding-step');
const dots = document.querySelectorAll<HTMLElement>('.progress-dots .dot');
const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
const licenseInput = document.getElementById('license-key') as HTMLInputElement;
const licenseError = document.getElementById('license-error')!;
const buddyNameInput = document.getElementById('buddy-name') as HTMLInputElement;
const voiceSelect = document.getElementById('voice-select') as HTMLSelectElement;
const appPickerEl = document.getElementById('app-picker')!;
const apiKeysEl = document.getElementById('api-keys')!;
const apiKeysEmptyEl = document.getElementById('api-keys-empty')!;
const firstWinsEl = document.getElementById('first-wins-chips')!;

// v0.19.0 PR-6 — set data-platform so the Liquid Glass theme picks up.
// macOS is the only platform we ship to today (this is the macOS port),
// but the attribute is feature-gated against navigator.platform so a future
// cross-platform build won't accidentally apply mac vibrancy on Windows.
const IS_MAC = (navigator.platform || '').toLowerCase().includes('mac');
(function setPlatform(): void {
  const p = (navigator.platform || '').toLowerCase();
  if (p.includes('mac')) document.body.setAttribute('data-platform', 'mac');
  else if (p.includes('win')) document.body.setAttribute('data-platform', 'win');
  else document.body.setAttribute('data-platform', 'other');
})();

// Clippy initializes — main window shows, brain wakes, first-meeting greeting —
// ONLY when onboarding is complete AND closing, never while a step is still on
// screen. Idempotent so every exit path (Done / Later / chip / restart) can
// call it safely before closing the window.
let onboardingFinalized = false;
async function finalizeOnboarding(): Promise<void> {
  if (onboardingFinalized) return;
  onboardingFinalized = true;
  try { await window.clippy.onOnboardingComplete(); } catch { /* main logs */ }
}

function showStep(step: number): void {
  steps.forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.step) === step);
  });
  dots.forEach((dot) => {
    dot.classList.toggle('active', Number(dot.dataset.dot) <= step);
  });

  btnBack.style.visibility = step > 1 ? 'visible' : 'hidden';
  // v0.19.0 PR-6 — button label varies per step. The app picker (now step 5)
  // is *skippable* (no tokens required); the API-key step (now 6) likewise;
  // the done step (now 7) is the terminal state with a different label.
  // Step 4 (permissions) drives its own Open/Skip controls — its footer Next
  // just proceeds, so it keeps the default "Next" label.
  if (step === 1) btnNext.textContent = 'Get Started';
  else if (step === 3) btnNext.textContent = 'Next';
  // v0.19.0 PR-6.2 — step 5 (app picker) mirrors step 6's pattern: button
  // label tells the user upfront that zero selections is a valid path. Without
  // this the user feels "stuck" because Next looks like it requires picks.
  // "Skip for now" removes the requirement-anxiety.
  else if (step === 5) btnNext.textContent = selectedAppIds.size > 0 ? 'Next' : 'Skip for now';
  else if (step === 6) btnNext.textContent = step6NextLabel(false);
  // v0.20.0 — step 7 is the optional Web Control / Browser Bridge step; step 8
  // is the terminal "you're all set" state.
  else if (step === 7) btnNext.textContent = 'Next';
  else if (step === 8) btnNext.textContent = 'Done';
  else btnNext.textContent = 'Next';
  // Step 4 (permission walkthrough) drives itself via the in-card Open/Skip
  // controls + auto-advance; hide the footer Next so it can't bypass the
  // remaining permissions (clicking it after the first perm is what skipped
  // Screen Recording + Automation). The in-card "Skip for now" always advances.
  btnNext.style.visibility = step === 4 ? 'hidden' : 'visible';

  // Step 7: if Screen Recording was granted during setup, surface the
  // restart as an explicit choice (Quit & Reopen / Later) instead of forcing
  // a quit on Done. The banner replaces the footer Done so the choice is clear.
  const relaunchBanner = document.getElementById('relaunch-banner');
  if (relaunchBanner) {
    const showBanner = step === 8 && permNeedsRelaunch;
    relaunchBanner.hidden = !showBanner;
    if (showBanner) btnNext.style.visibility = 'hidden';
  }

  currentStep = step;

  if (step === 3) populateVoices();
  // Step 4 = the guided permission walkthrough. Start it on entry; stop the
  // poll loop whenever we land on any other step.
  if (step === 4) void startPermWalkthrough();
  else stopPolling();
  if (step === 5) renderAppPicker();
  if (step === 6) renderApiKeyRows();
  if (step === 8) { renderFirstWins(); }
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

// ── Step 5: App picker ────────────────────────────────────────────────

function renderAppPicker(): void {
  // Idempotent — rebuilds the grid every time we enter step 5 so
  // re-visits via Back/Next don't show stale state if (hypothetically)
  // the catalog were dynamic. APP_CATALOG is static today but the
  // rebuild is cheap and keeps the contract simple.
  appPickerEl.innerHTML = '';
  for (const group of APP_CATALOG) {
    const groupEl = document.createElement('div');
    groupEl.className = 'app-group';
    const label = document.createElement('div');
    label.className = 'app-group-label';
    label.textContent = group.label;
    groupEl.appendChild(label);
    const grid = document.createElement('div');
    grid.className = 'app-grid';
    for (const app of group.apps) {
      grid.appendChild(makeAppCard(app));
    }
    groupEl.appendChild(grid);
    appPickerEl.appendChild(groupEl);
  }
}

function makeAppCard(app: AppCatalogEntry): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'app-card';
  btn.dataset.appId = app.id;
  btn.setAttribute('aria-pressed', String(selectedAppIds.has(app.id)));
  if (selectedAppIds.has(app.id)) btn.classList.add('selected');

  // Icon container — innerHTML is safe here because iconSvg is a static
  // string constant in app-catalog.ts (no user input).
  const iconWrap = document.createElement('span');
  iconWrap.className = 'app-card-icon';
  iconWrap.innerHTML = app.iconSvg;
  btn.appendChild(iconWrap);

  const name = document.createElement('span');
  name.className = 'app-card-name';
  name.textContent = app.name;
  btn.appendChild(name);

  const check = document.createElement('span');
  check.className = 'app-card-check';
  check.setAttribute('aria-hidden', 'true');
  // Glyph-only checkmark; styled via CSS to fade in when .selected.
  check.textContent = '✓';
  btn.appendChild(check);

  btn.addEventListener('click', () => {
    if (selectedAppIds.has(app.id)) {
      selectedAppIds.delete(app.id);
      btn.classList.remove('selected');
      btn.setAttribute('aria-pressed', 'false');
    } else {
      selectedAppIds.add(app.id);
      btn.classList.add('selected');
      btn.setAttribute('aria-pressed', 'true');
    }
    // v0.19.0 PR-6.2 — update Next-button copy live so the user sees
    // "Next" the moment they pick something, "Skip for now" if they
    // deselect back to zero. Matches step 5's affordance pattern.
    if (currentStep === 5) {
      btnNext.textContent = selectedAppIds.size > 0 ? 'Next' : 'Skip for now';
    }
  });

  return btn;
}

// ── Step 6: API-key entry ─────────────────────────────────────────────

// Single source of truth for the step-6 Next-button label. "Continue" when
// there are no API-capable apps to fill in; otherwise the affordance reflects
// whether the user has typed any token yet.
function step6NextLabel(noApiRows: boolean): string {
  if (noApiRows) return 'Continue';
  return pendingApiTokens.size > 0 ? 'Save & Finish' : 'Skip for now';
}

function renderApiKeyRows(): void {
  apiKeysEl.innerHTML = '';
  const apiCapable = Array.from(selectedAppIds)
    .map((id) => APP_BY_ID[id])
    .filter((app): app is AppCatalogEntry => !!app && app.hasApi);

  if (apiCapable.length === 0) {
    apiKeysEmptyEl.style.display = 'block';
    btnNext.textContent = step6NextLabel(true);
    return;
  }
  apiKeysEmptyEl.style.display = 'none';

  for (const app of apiCapable) {
    apiKeysEl.appendChild(makeKeyRow(app));
  }
}

function makeKeyRow(app: AppCatalogEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'key-row';
  row.dataset.appId = app.id;

  const head = document.createElement('div');
  head.className = 'key-row-head';
  const icon = document.createElement('span');
  icon.className = 'key-row-icon';
  icon.innerHTML = app.iconSvg;
  head.appendChild(icon);
  const name = document.createElement('span');
  name.className = 'key-row-name';
  name.textContent = app.name;
  head.appendChild(name);
  row.appendChild(head);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'key-row-input-wrap';
  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'key-row-input';
  input.placeholder = `Paste your ${app.name} token`;
  input.autocomplete = 'off';
  input.spellcheck = false;
  // Pre-fill if user navigated back & forth and already typed something
  const pending = pendingApiTokens.get(app.id);
  if (pending) input.value = pending;
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (v) pendingApiTokens.set(app.id, v);
    else pendingApiTokens.delete(app.id);
    // Update Next button label to reflect whether the user has typed
    // anything — the affordance "Save & Finish" vs "Skip for now"
    // tells them the state of their input without scrolling.
    btnNext.textContent = step6NextLabel(false);
  });
  inputWrap.appendChild(input);
  row.appendChild(inputWrap);

  const footer = document.createElement('div');
  footer.className = 'key-row-footer';

  const skipLink = document.createElement('button');
  skipLink.type = 'button';
  skipLink.className = 'key-row-link';
  skipLink.textContent = 'Connect later';
  skipLink.addEventListener('click', () => {
    input.value = '';
    pendingApiTokens.delete(app.id);
    btnNext.textContent = step6NextLabel(false);
  });
  footer.appendChild(skipLink);

  if (app.apiInstructions) {
    const disclosureBtn = document.createElement('button');
    disclosureBtn.type = 'button';
    disclosureBtn.className = 'key-row-link';
    disclosureBtn.textContent = 'How to get this';
    const help = document.createElement('div');
    help.className = 'key-row-help hidden';
    help.textContent = app.apiInstructions;
    disclosureBtn.addEventListener('click', () => {
      help.classList.toggle('hidden');
      disclosureBtn.textContent = help.classList.contains('hidden') ? 'How to get this' : 'Hide';
    });
    footer.appendChild(disclosureBtn);
    row.appendChild(footer);
    row.appendChild(help);
  } else {
    row.appendChild(footer);
  }

  return row;
}

// ── Step 8: First-wins chips ──────────────────────────────────────────

function renderFirstWins(): void {
  firstWinsEl.innerHTML = '';
  for (const chip of FIRST_WINS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'first-win-chip';
    btn.textContent = chip.label;
    btn.addEventListener('click', async () => {
      // Disable to prevent double-fire (the IPC + window.close race
      // is fast but real — user spam-clicks otherwise get queued).
      Array.from(firstWinsEl.querySelectorAll('button')).forEach((b) => (b as HTMLButtonElement).disabled = true);
      // Initialize Clippy first (wakes the brain so it can receive the task),
      // then fire the chosen first-win, then close.
      await finalizeOnboarding();
      try {
        await window.clippy.fireFirstWinChip?.(chip.prompt);
      } catch { /* main-side logs; we still close */ }
      window.close();
    });
    firstWinsEl.appendChild(btn);
  }
}

// ── Step 4: Permission walkthrough ────────────────────────────────────
// Clippy walks the user through the macOS permission prompts one at a time.
// The pure state machine lives in permission-flow.ts; this code owns the
// sprite, the IPC calls, and the poll loop that detects a freshly-granted
// permission.

let permFlow: PermissionFlow | null = null;
let permPollTimer: number | null = null;
// Tracks which permission the card currently shows, so we only replay the
// card re-entrance animation (.perm-enter) when a NEW permission appears.
let lastPermKind: string | null = null;
let permStarting = false;
// Set when Screen Recording is granted during the walkthrough. The relaunch
// it needs is DEFERRED to the very end (the Done button) so it never interrupts
// the rest of onboarding — restarting mid-flow was booting the user out.
let permNeedsRelaunch = false;

async function permSnapshot(): Promise<PermSnapshot> {
  const p = await window.clippy.getPermissions?.();
  return {
    accessibility: p?.accessibility === 'granted',
    screenRecording: p?.screenRecording === 'granted',
    automationAnyBrowser: Object.values(p?.automation ?? {}).some((v) => v === 'granted'),
  };
}

function renderPerm(state: ReturnType<PermissionFlow['current']>): void {
  if (state.done) { stopPolling(); showStep(5); return; } // proceed to app picker
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
  // relaunch is deferred to the Done button).
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
    showStep(2);
    licenseInput.focus();
    return;
  }

  if (currentStep === 2) {
    const key = licenseInput.value.trim().toUpperCase();
    licenseError.textContent = '';

    // Step 2's footer Next is the "I pasted a key" path. If the field is
    // empty, nudge the user toward the free button rather than throwing a
    // format error — free is the primary path now.
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
        showStep(3);
      } else if ((result as { reason?: string }).reason === 'unreachable') {
        licenseError.textContent = "Couldn't reach our validation server. Check your connection and try again — your key isn't necessarily wrong.";
      } else {
        licenseError.textContent = 'Invalid license key. Please check and try again.';
      }
    } catch {
      licenseError.textContent = 'Could not validate. Check your internet connection.';
    } finally {
      btnNext.disabled = false;
    }
    return;
  }

  if (currentStep === 3) {
    // Persist license + buddy + voice on transition out of step 3 so
    // the user's identity is committed BEFORE the optional steps 5–6.
    // If they bail at step 5 (close the window), they still have a
    // working ClippyAI with the right name + voice.
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
      // v0.19.0 PR-6.4 — commit wake-word preference. Stored via the
      // shared updateSettings channel (same shape Settings → Voice uses)
      // so a single source of truth holds the pref. Runtime is a no-op
      // today; ipc.ts persists the flag, and the future wake-word
      // module will read licenseStore.get('wakeWordEnabled') at boot.
      const wakeToggle = document.getElementById('onboarding-wake-word') as HTMLInputElement | null;
      const wakeWordEnabled = wakeToggle ? wakeToggle.checked : false;
      try {
        await window.clippy.updateSettings({ wakeWordEnabled });
      } catch { /* non-fatal */ }
      // Advance from "Meet Clippy". On macOS, step 4 is the TCC permission
      // walkthrough (Accessibility + Screen Recording). Windows requires NO
      // per-app grants for desktop automation, screen capture, or input
      // synthesis — the mac permission APIs don't exist here, and running
      // the walkthrough would poll "Needed" forever with no way to grant.
      // So on Windows we skip straight to the app picker (step 5).
      showStep(IS_MAC ? 4 : 5);
    } catch {
      btnNext.textContent = 'Next';
    } finally {
      btnNext.disabled = false;
    }
    return;
  }

  if (currentStep === 4) {
    // Permission walkthrough. The Open/Skip controls inside the step drive the
    // PermissionFlow; the footer Next just proceeds to the app picker. (The
    // walkthrough also auto-advances to step 5 when the flow completes.)
    stopPolling();
    showStep(5);
    return;
  }

  if (currentStep === 5) {
    // Persist user-app selection. Empty set is allowed (user can finish
    // onboarding without picking anything; they'll just get the generic
    // UI-automation path for everything).
    try {
      await window.clippy.setUserApps?.(Array.from(selectedAppIds));
    } catch { /* silent — best-effort */ }
    showStep(6);
    return;
  }

  if (currentStep === 6) {
    // Save any pending tokens to the keychain. Note: the user can also
    // just skip — pendingApiTokens.size === 0 is a valid completion.
    btnNext.disabled = true;
    btnNext.textContent = 'Saving...';
    try {
      for (const [appId, token] of pendingApiTokens) {
        try { await window.clippy.setApiKey?.(appId, token); } catch { /* per-key best-effort */ }
      }
    } finally {
      btnNext.disabled = false;
    }
    // → step 7: optional Web Control / Browser Bridge. showStep sets 'Next'.
    showStep(7);
    return;
  }

  if (currentStep === 7) {
    // Leaving the optional Web Control step → the terminal "you're all set"
    // screen. Clippy still initializes only on close (finalizeOnboarding),
    // never while a step is on screen.
    showStep(8);
    return;
  }

  if (currentStep === 8) {
    // Initialize Clippy now (on close), then close. The Screen-Recording
    // relaunch is a separate explicit choice via the relaunch banner.
    await finalizeOnboarding();
    window.close();
  }
});

btnBack.addEventListener('click', () => {
  if (currentStep > 1) {
    // Clippy now initializes only on close, so navigating back from step 7 is
    // safe — nothing has been launched yet. Clamp to step 1.
    let target = Math.max(1, currentStep - 1);
    // On Windows, step 4 (mac TCC permission walkthrough) was skipped on the
    // way forward, so Back from step 5 must return to step 3, not the empty
    // step 4. Keep the two in sync with the forward-skip above.
    if (!IS_MAC && target === 4) target = 3;
    showStep(target);
  }
});

// Step 7 relaunch banner — explicit Screen-Recording restart choice.
// "Quit & Reopen" applies SR immediately; "Later" just closes onboarding and
// lets SR take effect on Clippy's next launch (he reinitializes on completion
// anyway, so deferring is harmless).
document.getElementById('btn-relaunch-now')?.addEventListener('click', async () => {
  await finalizeOnboarding(); // persist profile so the relaunch lands in the app
  void window.clippy.restartApp?.();
});
document.getElementById('btn-relaunch-later')?.addEventListener('click', async () => {
  await finalizeOnboarding();
  window.close();
});

// v0.19.0 PR-6.2 — explicit "I'll set this up later" escape from the app
// picker (step 5). Bypasses step 5's setUserApps call, step 6 (no apps => no
// API rows to fill in anyway), AND the optional Web Control step → jumps
// straight to step 8 (the terminal "all set" screen). Clippy is NOT finalized
// here; initialization happens on close (Done / chip). They can always finish
// in Settings → Apps later.
const btnSkipApps = document.getElementById('btn-skip-apps');
if (btnSkipApps) {
  btnSkipApps.addEventListener('click', async () => {
    selectedAppIds.clear();
    pendingApiTokens.clear();
    try { await window.clippy.setUserApps?.([]); } catch { /* best-effort */ }
    // Skip apps + API keys + the optional Web Control step → straight to "all set".
    showStep(8);
    // Clippy initializes on close (Done/chip), not here — step 8 is still shown.
  });
}

// v0.20.0 — Step 7: "Open install guide" opens the hosted Browser Bridge
// walkthrough (clippyai.app/extension → downloads from download.clippyai.app,
// no GitHub). Optional; the footer Next skips it. Settings → Web has the same.
const btnInstallBridge = document.getElementById('btn-install-bridge');
if (btnInstallBridge) {
  btnInstallBridge.addEventListener('click', async () => {
    try { await window.clippy.openExternalUrl('https://clippyai.app/extension'); } catch { /* main logs */ }
    document.getElementById('bridge-hint')?.removeAttribute('hidden');
  });
}

// Auto-uppercase license input. (The free/trial sections stay visible —
// they're distinct paths now, not a fallback that hides when a key is typed.)
licenseInput.addEventListener('input', () => {
  const pos = licenseInput.selectionStart;
  licenseInput.value = licenseInput.value.toUpperCase();
  licenseInput.setSelectionRange(pos, pos);
});

// ── Primary path: free signup (email → license key, no card) ─────────
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
    case 'offline': return "Couldn't reach our server. Check your connection and try again — or paste a license key below.";
    default: return 'Something went wrong. Try again, or paste a license key below.';
  }
}

// Reveal the email field on first tap; submit on the second.
btnUseFree.addEventListener('click', () => {
  freeError.textContent = '';
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
  btnFreeConfirm.disabled = true;
  btnFreeConfirm.textContent = 'Verifying…';
  let succeeded = false;
  try {
    const result = await window.clippy.freeSignup(email);
    if ('licenseKey' in result && result.licenseKey) {
      // Main has already persisted the key (same store the paste flow
      // writes). Mark the plan and skip straight past activation — the
      // user is signed in. We deliberately don't echo the key here.
      validatedPlan = result.plan || 'free';
      licenseInput.value = result.licenseKey;
      succeeded = true;
      // Brief confirmation so the user trusts the email was accepted before
      // we advance — and it doubles as a double-submit guard.
      btnFreeConfirm.textContent = "✓ You're in!";
      setTimeout(() => showStep(3), 700);
    } else {
      freeError.textContent = freeErrorMessage((result as { error: string }).error);
    }
  } catch {
    freeError.textContent = freeErrorMessage('offline');
  } finally {
    // Leave the success state intact while the 700ms confirmation plays out.
    if (!succeeded) {
      btnFreeConfirm.disabled = false;
      btnFreeConfirm.textContent = 'Confirm';
    }
  }
}

btnFreeConfirm.addEventListener('click', submitFreeSignup);
freeEmailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void submitFreeSignup(); }
});

// ── Secondary path: Power trial → opens Stripe checkout in browser ───
// Power $19.99, 7-day trial (live link). NOT the dead $9.99 Pro trial.
const STRIPE_POWER_TRIAL = 'https://buy.stripe.com/8x2bJ06jXfC65XDe2Oe3e03'; // $19.99/mo
const btnStartTrial = document.getElementById('btn-start-trial') as HTMLButtonElement;
const trialHint = document.getElementById('trial-hint')!;

btnStartTrial.addEventListener('click', async () => {
  await window.clippy.openExternalUrl(STRIPE_POWER_TRIAL);
  btnStartTrial.disabled = true;
  btnStartTrial.textContent = 'Opening Stripe...';
  trialHint.style.display = 'block';
  licenseInput.focus();
  setTimeout(() => {
    btnStartTrial.disabled = false;
    btnStartTrial.textContent = 'Start 7-Day Free Trial';
  }, 3000);
});

// Pre-load existing app + API state for re-entries via Settings → "Change License Key".
(async () => {
  try {
    const existing = await window.clippy.getUserApps?.();
    if (Array.isArray(existing)) for (const id of existing) selectedAppIds.add(id);
  } catch { /* no-op on first run */ }
})();
