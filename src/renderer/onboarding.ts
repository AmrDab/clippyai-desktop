// Window.clippy types live in src/preload/api.d.ts (single source of truth).
export {};

// v0.19.0 PR-6 — set data-platform on <body> so the CSS visual variant in
// style.css ([data-platform="win"] / [data-platform="mac"]) activates. We
// use navigator.userAgent here instead of process.platform because the
// renderer doesn't have direct access to Node's process global, and adding
// a new preload bridge just for this would conflict with A3's parallel
// work on main.ts (mac variant). Renderer-only platform detect keeps the
// two variants on separate code paths.
function detectPlatform(): 'win' | 'mac' | 'linux' {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('windows')) return 'win';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac';
  return 'linux';
}
document.body.setAttribute('data-platform', detectPlatform());

// v0.19.0 PR-6 — Fluent Reveal effect. Any element marked with
// [data-fluent-reveal] gets a CSS radial-gradient highlight whose center
// follows the cursor. We set --reveal-x / --reveal-y as element-scoped
// custom properties; the CSS in style.css ([data-platform="win"]
// [data-fluent-reveal]::before) reads them. Pure JS state mutation, no
// requestAnimationFrame — the browser already batches mousemove events at
// the display refresh rate and CSS custom property writes are cheap.
//
// We attach a single delegated listener on document so app-cards added
// dynamically (Step 5 builds API key rows from Step 4's selection) pick
// up the effect without us re-wiring per-render. The handler bails fast
// for events outside reveal elements, so the runtime cost is one closest()
// call per mousemove during onboarding only.
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

let currentStep = 1;
let validatedPlan = '';

const steps = document.querySelectorAll<HTMLElement>('.onboarding-step');
const dots = document.querySelectorAll<HTMLElement>('.progress-dots .dot');
const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
const licenseInput = document.getElementById('license-key') as HTMLInputElement;
const licenseError = document.getElementById('license-error')!;
const buddyNameInput = document.getElementById('buddy-name') as HTMLInputElement;
const voiceSelect = document.getElementById('voice-select') as HTMLSelectElement;

function showStep(step: number): void {
  steps.forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.step) === step);
  });
  dots.forEach((dot) => {
    dot.classList.toggle('active', Number(dot.dataset.dot) <= step);
  });

  btnBack.style.visibility = step > 1 ? 'visible' : 'hidden';
  btnNext.textContent = step === 3 ? 'Finish' : step === 1 ? 'Get Started' : 'Next';
  currentStep = step;

  if (step === 3) {
    populateVoices();
  }
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

btnNext.addEventListener('click', async () => {
  if (currentStep === 1) {
    showStep(2);
    licenseInput.focus();
    return;
  }

  if (currentStep === 2) {
    const key = licenseInput.value.trim().toUpperCase();
    licenseError.textContent = '';

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
        // v0.17.1 — distinguish "server down" from "bad key". Showing
        // "Invalid license" when the worker had a 5xx was painful UX
        // and the actual bug we shipped this hotfix for.
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
    const buddyName = buddyNameInput.value.trim() || 'Clippy';
    const ttsVoice = voiceSelect.value;
    const key = licenseInput.value.trim().toUpperCase();
    // v0.17.7 — capture user's name atomically with the license save.
    // Blank field is allowed; the post-onboarding fallback prompt picks
    // it up later. But when the user fills it here, the name lands in
    // user.md BEFORE the main window opens, so the brain greets by name
    // on the very first reply — no race condition, no missed prompt.
    const userNameInput = document.getElementById('user-name') as HTMLInputElement | null;
    const userName = (userNameInput?.value || '').trim();

    btnNext.disabled = true;
    btnNext.textContent = 'Saving...';

    try {
      await window.clippy.saveLicense(key, validatedPlan, buddyName, ttsVoice);
      if (userName) {
        // Best-effort: a save failure here shouldn't block onboarding.
        try { await window.clippy.saveUserProfile({ Name: userName }); }
        catch (err) { console.warn('[onboarding] saveUserProfile failed (non-fatal)', err); }
      }
      await window.clippy.onOnboardingComplete();
      window.close();
    } catch {
      btnNext.disabled = false;
      btnNext.textContent = 'Finish';
    }
  }
});

btnBack.addEventListener('click', () => {
  if (currentStep > 1) {
    showStep(currentStep - 1);
  }
});

// Auto-uppercase license input + hide trial section when typing
const trialSection = document.getElementById('trial-section')!;

licenseInput.addEventListener('input', () => {
  const pos = licenseInput.selectionStart;
  licenseInput.value = licenseInput.value.toUpperCase();
  licenseInput.setSelectionRange(pos, pos);

  // Hide trial button once user has a key — they don't need it
  trialSection.style.display = licenseInput.value.trim().length > 0 ? 'none' : '';
});

// ── Free trial button → opens Stripe checkout in browser ─────────────
const STRIPE_PRO_TRIAL = 'https://buy.stripe.com/7sY6oGaAd2Pk71H2k6e3e02';
const btnStartTrial = document.getElementById('btn-start-trial') as HTMLButtonElement;
const trialHint = document.getElementById('trial-hint')!;

btnStartTrial.addEventListener('click', async () => {
  await window.clippy.openExternalUrl(STRIPE_PRO_TRIAL);
  btnStartTrial.disabled = true;
  btnStartTrial.textContent = 'Opening Stripe...';
  trialHint.style.display = 'block';
  licenseInput.focus();
  setTimeout(() => {
    btnStartTrial.disabled = false;
    btnStartTrial.textContent = 'Start 7-Day Free Trial';
  }, 3000);
});
