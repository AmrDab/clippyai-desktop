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

// Check for updates — wire both Tools tab and About tab buttons
function wireUpdateButton(btnId: string, statusId: string): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  const status = document.getElementById(statusId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (status) status.textContent = 'Searching for updates...';
    btn.disabled = true;
    await window.clippy.checkForUpdates();
    setTimeout(() => {
      btn.disabled = false;
      if (status && status.textContent === 'Searching for updates...') {
        status.textContent = 'You\'re on the latest version!';
      }
    }, 5000);
  });
}
wireUpdateButton('btn-check-update', 'update-status');
wireUpdateButton('btn-check-update-about', 'update-status-about');

// Listen for update notifications — update all status elements
function setAllUpdateStatus(html: string): void {
  for (const id of ['update-status', 'update-status-about']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
}

window.clippy.onUpdateAvailable((version: string) => {
  setAllUpdateStatus(`<strong>v${version} available!</strong> <button class="btn-dl-update" style="margin-left:8px;padding:2px 8px;cursor:pointer;">Download</button>`);
  document.querySelectorAll('.btn-dl-update').forEach((btn) => {
    btn.addEventListener('click', () => {
      setAllUpdateStatus('Downloading...');
      window.clippy.downloadUpdate();
    });
  });
});

window.clippy.onUpdateReady((version: string) => {
  setAllUpdateStatus(`<strong>v${version} ready!</strong> <button class="btn-inst-update" style="margin-left:8px;padding:2px 8px;cursor:pointer;background:#4CAF50;color:white;border:none;border-radius:3px;">Restart & Update</button>`);
  document.querySelectorAll('.btn-inst-update').forEach((btn) => {
    btn.addEventListener('click', () => window.clippy.installUpdate());
  });
});

// Init
loadConfig();
testConnection();
