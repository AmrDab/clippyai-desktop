declare global {
  interface Window {
    clippy: {
      validateLicense: (key: string) => Promise<{ valid: boolean; plan: string }>;
      saveLicense: (key: string, plan: string, buddyName: string, ttsVoice: string) => Promise<boolean>;
      saveUserProfile: (data: Record<string, string>) => Promise<boolean>;
      closeWindow: () => void;
      openExternalUrl: (url: string) => Promise<boolean>;
      onOnboardingComplete: () => void;
    };
  }
}

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
    const userName = (document.getElementById('user-name') as HTMLInputElement).value.trim();
    const buddyName = buddyNameInput.value.trim() || 'Clippy';
    const ttsVoice = voiceSelect.value;
    const key = licenseInput.value.trim().toUpperCase();

    btnNext.disabled = true;
    btnNext.textContent = 'Saving...';

    try {
      await window.clippy.saveLicense(key, validatedPlan, buddyName, ttsVoice);
      if (userName) {
        await window.clippy.saveUserProfile({ Name: userName });
      }
      window.clippy.onOnboardingComplete();
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
