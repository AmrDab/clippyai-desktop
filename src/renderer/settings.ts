declare global {
  interface Window {
    clippy: {
      getConfig: () => Promise<Record<string, unknown>>;
      updateSettings: (settings: Record<string, unknown>) => Promise<boolean>;
      executeTool: (tool: string, params?: Record<string, unknown>) => Promise<unknown>;
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
  licensePlanDisplay.textContent = (config.plan as string) || 'Unknown';
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
  try {
    await window.clippy.executeTool('get_active_window');
    ccStatusDot.className = 'status-dot connected';
    ccStatusText.textContent = 'Connected';
  } catch {
    ccStatusDot.className = 'status-dot disconnected';
    ccStatusText.textContent = 'Not connected';
  }
}

btnTestConnection.addEventListener('click', testConnection);

// Init
loadConfig();
testConnection();
