declare global {
  interface Window {
    clippy: {
      getConfig: () => Promise<Record<string, unknown>>;
      updateSettings: (settings: Record<string, unknown>) => Promise<boolean>;
      testClawdCursor: () => Promise<boolean>;
      clearLicense: () => Promise<boolean>;
      openOnboarding: () => void;
      openExternalUrl: (url: string) => Promise<boolean>;
      checkForUpdates: () => Promise<boolean>;
      downloadUpdate: () => Promise<boolean>;
      installUpdate: () => Promise<boolean>;
      onUpdateAvailable: (cb: (version: string) => void) => void;
      onUpdateReady: (cb: (version: string) => void) => void;
    };
  }
}

// Nav switching
const navItems = document.querySelectorAll<HTMLElement>('.settings-nav-item');
const sections = document.querySelectorAll<HTMLElement>('.settings-section');

navItems.forEach((item) => {
  item.addEventListener('click', () => {
    const target = item.dataset.section!;
    navItems.forEach((n) => n.classList.toggle('active', n === item));
    sections.forEach((s) => s.classList.toggle('active', s.dataset.section === target));
  });
});

// Elements
const buddyNameInput = document.getElementById('setting-buddy-name') as HTMLInputElement;
const aiEndpointInput = document.getElementById('setting-ai-endpoint') as HTMLInputElement;
const proactiveIntervalRange = document.getElementById('setting-proactive-interval') as HTMLInputElement;
const proactiveIntervalValue = document.getElementById('proactive-interval-value')!;
const proactiveToggle = document.getElementById('setting-proactive') as HTMLInputElement;
const voiceSelect = document.getElementById('setting-voice') as HTMLSelectElement;
const speechRateRange = document.getElementById('setting-speech-rate') as HTMLInputElement;
const speechRateValue = document.getElementById('speech-rate-value')!;
const licenseKeyDisplay = document.getElementById('license-key-display')!;
const licensePlanDisplay = document.getElementById('license-plan-display')!;
const ccStatusDot = document.getElementById('cc-status-dot')!;
const ccStatusText = document.getElementById('cc-status-text')!;
const btnTestConnection = document.getElementById('btn-test-connection')!;

// Populate voices
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

window.speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();

// Load config
async function loadConfig(): Promise<void> {
  const config = await window.clippy.getConfig();
  buddyNameInput.value = (config.buddyName as string) || 'Clippy';
  aiEndpointInput.value = (config.aiEndpoint as string) || '';
  proactiveToggle.checked = config.proactiveEnabled as boolean;

  const intervalSec = Math.round((config.proactiveInterval as number) / 1000);
  proactiveIntervalRange.value = String(intervalSec);
  proactiveIntervalValue.textContent = `${intervalSec}s`;

  if (config.ttsVoice) {
    voiceSelect.value = config.ttsVoice as string;
  }

  // License
  const key = (config.licenseKey as string) || '';
  licenseKeyDisplay.textContent = key ? maskKey(key) : 'No key set';
  const planName = (config.plan as string) || 'Unknown';
  licensePlanDisplay.textContent = planName;
  showPlanFeatures(planName);
}

function maskKey(key: string): string {
  // Show first and last segment, mask middle
  const parts = key.split('-');
  if (parts.length < 4) return key;
  return `${parts[0]}-****-****-${parts[3]}`;
}

// Save on change with debounce
let saveTimeout: number | null = null;
function debounceSave(settings: Record<string, unknown>): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = window.setTimeout(() => {
    window.clippy.updateSettings(settings);
  }, 500);
}

buddyNameInput.addEventListener('input', () => {
  debounceSave({ buddyName: buddyNameInput.value.trim() });
});

aiEndpointInput.addEventListener('input', () => {
  debounceSave({ aiEndpoint: aiEndpointInput.value.trim() });
});

proactiveIntervalRange.addEventListener('input', () => {
  const sec = Number(proactiveIntervalRange.value);
  proactiveIntervalValue.textContent = `${sec}s`;
  debounceSave({ proactiveInterval: sec * 1000 });
});

proactiveToggle.addEventListener('change', () => {
  window.clippy.updateSettings({ proactiveEnabled: proactiveToggle.checked });
});

voiceSelect.addEventListener('change', () => {
  window.clippy.updateSettings({ ttsVoice: voiceSelect.value });
});

speechRateRange.addEventListener('input', () => {
  speechRateValue.textContent = `${speechRateRange.value}x`;
});

// Test ClawdCursor connection
async function testConnection(): Promise<void> {
  ccStatusText.textContent = 'Testing...';
  ccStatusDot.className = 'status-dot disconnected';
  const connected = await window.clippy.testClawdCursor();
  if (connected) {
    ccStatusDot.className = 'status-dot connected';
    ccStatusText.textContent = 'Connected';
  } else {
    ccStatusDot.className = 'status-dot disconnected';
    ccStatusText.textContent = 'Not connected';
  }
}

btnTestConnection.addEventListener('click', testConnection);

// Change license key
const btnChangeLicense = document.getElementById('btn-change-license');
if (btnChangeLicense) {
  btnChangeLicense.addEventListener('click', async () => {
    await window.clippy.clearLicense();
    window.clippy.openOnboarding();
    window.close();
  });
}

// Plan features display
const PLAN_FEATURES_MAP: Record<string, string[]> = {
  basic: ['Chat & questions', 'Web-grounded answers', '500K tokens/month'],
  pro: ['Everything in Basic', 'Desktop automation', 'Browser control', '2M tokens/month'],
  power: ['Everything in Pro', 'Multi-monitor', 'Custom personas', 'Priority support', '5M tokens/month'],
};

function showPlanFeatures(plan: string): void {
  const el = document.getElementById('plan-features');
  if (!el) return;
  const lower = (plan || 'basic').toLowerCase();
  const features = PLAN_FEATURES_MAP[lower] || PLAN_FEATURES_MAP.basic;
  el.innerHTML = features.map(f => `✓ ${f}`).join('<br>');
}

// About links — open in default browser
for (const [id, url] of [
  ['link-website', 'https://clippyai.app'],
  ['link-privacy', 'https://clippyai.app/privacy'],
  ['link-terms', 'https://clippyai.app/terms'],
  ['link-support', 'mailto:hello@clippyai.app'],
] as const) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      window.clippy.openExternalUrl(url);
    });
  }
}

// Check for updates button
const btnCheckUpdate = document.getElementById('btn-check-update');
const updateStatus = document.getElementById('update-status');
if (btnCheckUpdate) {
  btnCheckUpdate.addEventListener('click', async () => {
    if (updateStatus) updateStatus.textContent = 'Checking for updates...';
    btnCheckUpdate.disabled = true;
    await window.clippy.checkForUpdates();
    // Wait a moment for the updater to respond
    setTimeout(() => {
      btnCheckUpdate.disabled = false;
      if (updateStatus && updateStatus.textContent === 'Checking for updates...') {
        updateStatus.textContent = 'You\'re on the latest version!';
      }
    }, 5000);
  });
}

// Listen for update notifications in settings too
window.clippy.onUpdateAvailable((version: string) => {
  if (updateStatus) {
    updateStatus.innerHTML = `<strong>v${version} available!</strong> <button id="btn-download-update" style="margin-left:8px;padding:2px 8px;cursor:pointer;">Download</button>`;
    document.getElementById('btn-download-update')?.addEventListener('click', () => {
      if (updateStatus) updateStatus.textContent = 'Downloading...';
      window.clippy.downloadUpdate();
    });
  }
});

window.clippy.onUpdateReady((version: string) => {
  if (updateStatus) {
    updateStatus.innerHTML = `<strong>v${version} ready!</strong> <button id="btn-install-update" style="margin-left:8px;padding:2px 8px;cursor:pointer;background:#4CAF50;color:white;border:none;border-radius:3px;">Restart & Update</button>`;
    document.getElementById('btn-install-update')?.addEventListener('click', () => {
      window.clippy.installUpdate();
    });
  }
});

// Init
loadConfig();
testConnection();
