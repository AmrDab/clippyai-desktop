// Window.clippy types live in src/preload/api.d.ts (single source of truth).
export {};

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

  // Dynamic version from app
  const versionEl = document.getElementById('app-version');
  if (versionEl && config.appVersion) {
    versionEl.textContent = `ClippyAI v${config.appVersion}`;
  }

  const intervalSec = Math.round((config.proactiveInterval as number) / 1000);
  proactiveIntervalRange.value = String(intervalSec);
  proactiveIntervalValue.textContent = `${intervalSec}s`;

  // v0.12.3 — load cooldown + bubble auto-hide
  const cooldownMin = Math.round(((config.proactiveCooldownMs as number) || 600000) / 60000);
  const cdRange = document.getElementById('setting-proactive-cooldown') as HTMLInputElement | null;
  const cdLabel = document.getElementById('proactive-cooldown-value');
  if (cdRange && cdLabel) {
    cdRange.value = String(cooldownMin);
    cdLabel.textContent = cooldownMin === 0 ? '0 (chatty)' : `${cooldownMin} min`;
  }
  const hideSel = document.getElementById('setting-bubble-hide') as HTMLSelectElement | null;
  if (hideSel) {
    const hideMs = Number(config.bubbleAutoHideMs);
    if ([0, 15000, 30000, 60000].includes(hideMs)) hideSel.value = String(hideMs);
  }

  // v0.19.0 PR-2 — bubble default state + pin
  const defStateSel = document.getElementById('setting-bubble-default-state') as HTMLSelectElement | null;
  if (defStateSel) {
    const v = String(config.bubbleDefaultState || 'standard');
    defStateSel.value = (v === 'compact' || v === 'standard') ? v : 'standard';
  }
  const pinEl = document.getElementById('setting-bubble-pinned') as HTMLInputElement | null;
  if (pinEl) pinEl.checked = Boolean(config.bubblePinned);

  if (config.ttsVoice) {
    voiceSelect.value = config.ttsVoice as string;
  }

  // TTS enabled toggle + speech rate
  const ttsEl = document.getElementById('setting-tts-enabled') as HTMLInputElement;
  if (ttsEl) ttsEl.checked = config.ttsEnabled !== false; // default true
  // v0.17.0 — voice input enabled toggle + STT-ready status panel
  const voiceEl = document.getElementById('setting-voice-enabled') as HTMLInputElement | null;
  if (voiceEl) {
    voiceEl.checked = config.voiceEnabled !== false; // default true
    voiceEl.addEventListener('change', () => {
      window.clippy.updateSettings({ voiceEnabled: voiceEl.checked });
    });
  }
  // v0.17.2 — wake-word preference. Pre-v0.17.2 the toggle was `disabled`
  // and stuck off, which made it look broken. Now it's interactive — the
  // preference is persisted to licenseStore, and once the on-device
  // wake-word model ships in a later patch, it'll start respecting the
  // saved value automatically. Honest "it works, just not implemented
  // yet" beats "looks broken".
  const wakeEl = document.getElementById('setting-wake-word') as HTMLInputElement | null;
  if (wakeEl) {
    wakeEl.checked = config.wakeWordEnabled === true; // default off
    wakeEl.addEventListener('change', () => {
      window.clippy.updateSettings({ wakeWordEnabled: wakeEl.checked });
    });
  }
  // Probe STT availability and surface a status banner. If whisper-cli
  // failed to install (rare but possible if user antivirus quarantined
  // it), users need to see why voice isn't working before they file a
  // support ticket.
  const sttStatusEl = document.getElementById('stt-status');
  if (sttStatusEl && window.clippy.sttStatus) {
    window.clippy.sttStatus().then((s) => {
      if (s.ready) {
        sttStatusEl.textContent = '✓ Voice ready — bundled whisper.cpp (base.en, 5-bit quantized, ~57 MB) loaded';
        (sttStatusEl as HTMLElement).style.color = '#2e7d32';
        (sttStatusEl as HTMLElement).style.background = '#e8f5e9';
      } else {
        sttStatusEl.textContent = `✗ Voice unavailable: ${s.reason || 'unknown'}`;
        (sttStatusEl as HTMLElement).style.color = '#c62828';
        (sttStatusEl as HTMLElement).style.background = '#ffebee';
      }
    }).catch((err) => {
      sttStatusEl.textContent = `✗ STT probe failed: ${err.message}`;
    });
  }
  if (config.speechRate) {
    speechRateRange.value = String(config.speechRate);
    speechRateValue.textContent = `${config.speechRate}x`;
  }
  // v0.16.0 — load pitch + volume
  const pitchEl = document.getElementById('setting-speech-pitch') as HTMLInputElement | null;
  const pitchValueEl = document.getElementById('speech-pitch-value');
  if (pitchEl && pitchValueEl && typeof config.speechPitch === 'number') {
    pitchEl.value = String(config.speechPitch);
    pitchValueEl.textContent = String(config.speechPitch);
  }
  const volEl = document.getElementById('setting-speech-volume') as HTMLInputElement | null;
  const volValueEl = document.getElementById('speech-volume-value');
  if (volEl && volValueEl && typeof config.speechVolume === 'number') {
    volEl.value = String(config.speechVolume);
    volValueEl.textContent = `${Math.round(config.speechVolume * 100)}%`;
  }

  // Launch on startup
  const launchEl = document.getElementById('setting-launch-startup') as HTMLInputElement;
  if (launchEl) launchEl.checked = Boolean(config.launchOnStartup);

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

// aiEndpoint field removed — locked to official API

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
  debounceSave({ speechRate: Number(speechRateRange.value) });
});

// v0.16.0 — pitch + volume + engine picker. Three new controls in the
// Voice tab so users can dial in their preferred TTS without waiting for
// Piper / ElevenLabs to land.
const pitchRange = document.getElementById('setting-speech-pitch') as HTMLInputElement | null;
const pitchValue = document.getElementById('speech-pitch-value');
if (pitchRange && pitchValue) {
  pitchRange.addEventListener('input', () => {
    pitchValue.textContent = pitchRange.value;
    debounceSave({ speechPitch: Number(pitchRange.value) });
  });
}
const volumeRange = document.getElementById('setting-speech-volume') as HTMLInputElement | null;
const volumeValue = document.getElementById('speech-volume-value');
if (volumeRange && volumeValue) {
  volumeRange.addEventListener('input', () => {
    volumeValue.textContent = `${Math.round(Number(volumeRange.value) * 100)}%`;
    debounceSave({ speechVolume: Number(volumeRange.value) });
  });
}
const voicesFeedbackLink = document.getElementById('link-voices-feedback');
if (voicesFeedbackLink) voicesFeedbackLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.clippy.openExternalUrl('https://clippyai.app');
});

// TTS Enable toggle — this IS the "AI voice toggle" the user sees in Voice tab
const ttsToggle = document.getElementById('setting-tts-enabled') as HTMLInputElement;
if (ttsToggle) {
  ttsToggle.addEventListener('change', () => {
    window.clippy.updateSettings({ ttsEnabled: ttsToggle.checked });
  });
}

// v0.12.3 — proactive cooldown slider (0–30 min). 0 = chatty mode.
const proactiveCooldownRange = document.getElementById('setting-proactive-cooldown') as HTMLInputElement | null;
const proactiveCooldownValue = document.getElementById('proactive-cooldown-value');
if (proactiveCooldownRange && proactiveCooldownValue) {
  proactiveCooldownRange.addEventListener('input', () => {
    const minutes = Number(proactiveCooldownRange.value);
    proactiveCooldownValue.textContent = minutes === 0 ? '0 (chatty)' : `${minutes} min`;
    debounceSave({ proactiveCooldownMs: minutes * 60_000 });
  });
}

// v0.12.3 — bubble auto-hide dropdown
const bubbleHideSelect = document.getElementById('setting-bubble-hide') as HTMLSelectElement | null;
if (bubbleHideSelect) {
  bubbleHideSelect.addEventListener('change', () => {
    window.clippy.updateSettings({ bubbleAutoHideMs: Number(bubbleHideSelect.value) });
  });
}

// v0.19.0 PR-2 — bubble default state + pin
const bubbleDefaultStateSel = document.getElementById('setting-bubble-default-state') as HTMLSelectElement | null;
if (bubbleDefaultStateSel) {
  bubbleDefaultStateSel.addEventListener('change', () => {
    window.clippy.updateSettings({ bubbleDefaultState: bubbleDefaultStateSel.value });
  });
}
const bubblePinnedEl = document.getElementById('setting-bubble-pinned') as HTMLInputElement | null;
if (bubblePinnedEl) {
  bubblePinnedEl.addEventListener('change', () => {
    window.clippy.updateSettings({ bubblePinned: bubblePinnedEl.checked });
  });
}

// v0.12.5 — manual proactive trigger. Useful for validating Brain settings
// without waiting for the next interval to elapse. Disables for 5s to
// prevent spam-clicking.
const fireTipBtn = document.getElementById('btn-fire-tip') as HTMLButtonElement | null;
const fireTipStatus = document.getElementById('fire-tip-status');
if (fireTipBtn) {
  fireTipBtn.addEventListener('click', async () => {
    fireTipBtn.disabled = true;
    if (fireTipStatus) fireTipStatus.textContent = 'Triggering…';
    // v0.17.2 — defensive wall-clock unstick. The previous code awaited
    // window.clippy.fireProactiveTip and only re-enabled the button + reset
    // status text inside a post-await setTimeout. If the IPC handler ever
    // hung (main-side exception, brain stuck mid-task), the await never
    // resolved, the setTimeout never scheduled, and the button stayed
    // "Triggering…" forever — exact symptom in the user's report. Wall-
    // clock timer runs independently of the await so the UI is never
    // stranded regardless of what main does.
    let settled = false;
    const finishUi = (text: string) => {
      if (settled) return;
      settled = true;
      if (fireTipStatus) fireTipStatus.textContent = text;
      setTimeout(() => {
        fireTipBtn.disabled = false;
        if (fireTipStatus && fireTipStatus.textContent === text) fireTipStatus.textContent = '';
      }, 5000);
    };
    const watchdog = setTimeout(() => finishUi('No response from background — try again.'), 15000);
    try {
      const res = await window.clippy.fireProactiveTip?.();
      clearTimeout(watchdog);
      finishUi((res && (res as { ok?: boolean }).ok)
        ? 'Triggered — check the bubble'
        : 'No tip fired (model returned silent, or in cooldown).');
    } catch (err) {
      clearTimeout(watchdog);
      finishUi(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// v0.12.5 — TTS voice preview. Uses the renderer's own Web Speech API
// directly so no IPC roundtrip; respects whatever voice + rate the user
// currently has selected in this Settings window even before they save.
const testVoiceBtn = document.getElementById('btn-test-voice') as HTMLButtonElement | null;
if (testVoiceBtn) {
  testVoiceBtn.addEventListener('click', () => {
    try {
      const utterance = new SpeechSynthesisUtterance('Hi! I\'m Clippy, your AI desktop assistant.');
      const voices = window.speechSynthesis.getVoices();
      const selected = voices.find((v) => v.name === voiceSelect.value);
      if (selected) utterance.voice = selected;
      utterance.rate = Number(speechRateRange.value) || 1.1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch { /* SpeechSynthesis unavailable — silent fail */ }
  });
}

// Launch on startup toggle
const launchToggle = document.getElementById('setting-launch-startup') as HTMLInputElement;
if (launchToggle) {
  launchToggle.addEventListener('change', () => {
    window.clippy.setLaunchOnStartup(launchToggle.checked);
  });
}

// Manage Subscription link
const manageSubLink = document.getElementById('manage-subscription');
if (manageSubLink) {
  manageSubLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.clippy.openSubscriptionPortal();
  });
}

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

// Check for updates — wire both Tools tab and About tab buttons.
//
// v0.17.2 — Two fixes for "Clippy verbally says 'update available' but
// the menu says 'couldn't reach update server'":
//   1. Cancel the pending fallback timeout whenever ANY result event
//      fires (update-available / update-not-available / update-failed).
//      Before this, the 30s "couldn't reach" fallback would clobber a
//      successful "v0.17.x available!" state if the user re-clicked the
//      search button before the timer expired.
//   2. The fallback now refuses to overwrite a status that already
//      contains "available", "ready", "Downloading", or "latest" — even
//      if there's a stale timer somehow still scheduled.
// Tracked as module-local so both updateButton instances share state
// and the event listeners below can clear timers from either button.
const _updateTimeouts: number[] = [];
function clearAllUpdateTimeouts(): void {
  while (_updateTimeouts.length) {
    const id = _updateTimeouts.pop();
    if (id !== undefined) clearTimeout(id);
  }
}
function statusLooksLikeResult(text: string | null): boolean {
  if (!text) return false;
  return /available|ready|Downloading|latest/i.test(text);
}
function wireUpdateButton(btnId: string, statusId: string): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  const status = document.getElementById(statusId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    // Any previous in-flight fallback could land on top of a fresh
    // search — cancel them up front.
    clearAllUpdateTimeouts();
    if (status) status.textContent = 'Searching for updates...';
    btn.disabled = true;
    await window.clippy.checkForUpdates();
    const timeoutId = window.setTimeout(() => {
      btn.disabled = false;
      if (status && !statusLooksLikeResult(status.textContent)) {
        status.textContent = 'Couldn\'t reach the update server — try again later.';
      }
    }, 30000);
    _updateTimeouts.push(timeoutId);
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

// Server confirmed: no newer version exists. Only NOW can we say "latest."
window.clippy.onUpdateNotAvailable(() => {
  clearAllUpdateTimeouts();
  setAllUpdateStatus('You\'re on the latest version!');
  // Re-enable the buttons
  for (const id of ['btn-check-update', 'btn-check-update-about']) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
  }
});

window.clippy.onUpdateAvailable((version: string) => {
  clearAllUpdateTimeouts();
  setAllUpdateStatus(`<strong>v${version} available!</strong> <button class="btn-dl-update" style="margin-left:8px;padding:2px 8px;cursor:pointer;">Download</button>`);
  for (const id of ['btn-check-update', 'btn-check-update-about']) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
  }
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

// Update check failed (network error, GitHub rate limit, NSIS install loop, etc.)
// Without this listener, the Settings panel showed "Searching for updates..."
// for the full 30 seconds before falling back to a generic "couldn't reach"
// message — even when the actual error was already known. Now we surface the
// real reason immediately and re-enable the button.
window.clippy.onUpdateFailed(({ reason, manualUrl }) => {
  clearAllUpdateTimeouts();
  const friendly = reason === 'previous-install-failed'
    ? `Auto-update keeps failing on this machine. <a href="${manualUrl}" target="_blank">Download manually</a> — that fixes it permanently.`
    : `Couldn't reach the update server (${reason}). <a href="${manualUrl}" target="_blank">Manual download</a>.`;
  setAllUpdateStatus(friendly);
  for (const id of ['btn-check-update', 'btn-check-update-about']) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
  }
});

// ───────────────────────────────────────────────────────────────────
// v0.14.1 — Skills tab + Mail Setup status + active model display
// ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function renderInstalledSkills(): Promise<void> {
  const container = document.getElementById('installed-skills-list');
  if (!container || !window.clippy.skillsList) return;
  container.textContent = 'Loading…';
  try {
    const skills = await window.clippy.skillsList();
    if (!skills || skills.length === 0) {
      container.innerHTML = '<p style="color:#888;font-style:italic;">No skills installed yet. Search ClawHub below to add one.</p>';
      return;
    }
    container.innerHTML = skills.map((s) => {
      const tagsHtml = (s.capability_tags || []).slice(0, 4).map((t) =>
        `<span style="display:inline-block;font-size:10px;padding:1px 6px;margin-right:4px;background:#eef;color:#446;border-radius:8px;">${escapeHtml(t)}</span>`,
      ).join('');
      const installedAt = s.installedAt ? new Date(s.installedAt).toLocaleDateString() : 'unknown';
      return `
        <div style="padding:10px;margin-bottom:6px;border:1px solid #eee;border-radius:6px;background:#fafafa;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;color:#333;">${escapeHtml(s.name)} <span style="font-size:11px;color:#999;font-weight:normal;">v${escapeHtml(s.version)}</span></div>
              <div style="font-size:12px;color:#666;margin-top:2px;">${escapeHtml(s.description).slice(0, 200)}</div>
              <div style="margin-top:6px;">${tagsHtml}</div>
              <div style="font-size:10px;color:#aaa;margin-top:4px;">Installed ${escapeHtml(installedAt)} · callable as <code>${escapeHtml(s.toolName)}</code></div>
            </div>
            <button class="btn-skill-uninstall" data-slug="${escapeHtml(s.slug)}" style="font-size:11px;padding:3px 10px;border:1px solid #d33;color:#d33;border-radius:3px;background:#fff;cursor:pointer;">Uninstall</button>
          </div>
        </div>`;
    }).join('');
    container.querySelectorAll('.btn-skill-uninstall').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const slug = (e.currentTarget as HTMLElement).dataset.slug;
        if (!slug || !window.clippy.skillsUninstall) return;
        if (!confirm(`Uninstall "${slug}"?\n\nThis removes the skill from your local cache. You can re-install from ClawHub anytime.`)) return;
        (e.currentTarget as HTMLButtonElement).disabled = true;
        await window.clippy.skillsUninstall(slug);
        await renderInstalledSkills();
      });
    });
  } catch (err) {
    container.innerHTML = `<p style="color:#d33;">Failed to load skills: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
  }
}

async function runSkillSearch(): Promise<void> {
  const input = document.getElementById('skill-search-input') as HTMLInputElement | null;
  const results = document.getElementById('skill-search-results');
  if (!input || !results || !window.clippy.skillsSearch) return;
  const q = input.value.trim();
  if (!q) { results.innerHTML = ''; return; }
  results.textContent = 'Searching…';
  try {
    const hits = await window.clippy.skillsSearch(q);
    if (!hits || hits.length === 0) {
      results.innerHTML = `<p style="color:#888;font-style:italic;">No matches for "${escapeHtml(q)}".</p>`;
      return;
    }
    results.innerHTML = hits.map((h) => {
      const safetyColor = h.safety === 'safe' ? '#16a34a' : h.safety === 'consent' ? '#d97706' : '#dc2626';
      const safetyLabel = h.safety === 'safe' ? '✓ safe' : h.safety === 'consent' ? '⚠ asks permission' : '✗ rejected';
      const installable = h.safety !== 'reject';
      return `
        <div style="padding:10px;margin-bottom:6px;border:1px solid #eee;border-radius:6px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;color:#333;">${escapeHtml(h.name)} <span style="font-size:11px;color:#999;font-weight:normal;">v${escapeHtml(h.version)}</span></div>
              <div style="font-size:12px;color:#666;margin-top:2px;">${escapeHtml((h.summary || '').slice(0, 200))}</div>
              <div style="margin-top:6px;">
                <span style="display:inline-block;font-size:10px;padding:1px 6px;margin-right:4px;background:#f0f0f0;color:${safetyColor};border-radius:8px;font-weight:600;">${safetyLabel}</span>
                ${(h.capability_tags || []).slice(0, 4).map((t) => `<span style="display:inline-block;font-size:10px;padding:1px 6px;margin-right:4px;background:#eef;color:#446;border-radius:8px;">${escapeHtml(t)}</span>`).join('')}
              </div>
            </div>
            ${installable
              ? `<button class="btn-skill-install" data-slug="${escapeHtml(h.slug)}" style="font-size:11px;padding:3px 10px;border:1px solid #16a34a;color:#16a34a;border-radius:3px;background:#fff;cursor:pointer;">Install</button>`
              : `<button disabled style="font-size:11px;padding:3px 10px;border:1px solid #ccc;color:#aaa;border-radius:3px;background:#f5f5f5;">Blocked</button>`}
          </div>
        </div>`;
    }).join('');
    results.querySelectorAll('.btn-skill-install').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const slug = (e.currentTarget as HTMLElement).dataset.slug;
        if (!slug || !window.clippy.skillsInstall) return;
        const btnEl = e.currentTarget as HTMLButtonElement;
        btnEl.disabled = true;
        btnEl.textContent = 'Installing…';
        const r = await window.clippy.skillsInstall(slug);
        if (r.ok) {
          btnEl.textContent = '✓ Installed';
          btnEl.style.color = '#999';
          await renderInstalledSkills();
        } else {
          btnEl.textContent = 'Failed';
          btnEl.title = r.error || 'Unknown error';
          btnEl.style.borderColor = '#dc2626';
          btnEl.style.color = '#dc2626';
          setTimeout(() => { btnEl.disabled = false; btnEl.textContent = 'Install'; btnEl.style.color = '#16a34a'; btnEl.style.borderColor = '#16a34a'; }, 3000);
        }
      });
    });
  } catch (err) {
    results.innerHTML = `<p style="color:#d33;">Search failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
  }
}

const skillSearchBtn = document.getElementById('btn-skill-search');
const skillSearchInput = document.getElementById('skill-search-input') as HTMLInputElement | null;
if (skillSearchBtn) skillSearchBtn.addEventListener('click', () => void runSkillSearch());
if (skillSearchInput) skillSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void runSkillSearch(); });
const refreshSkillsBtn = document.getElementById('btn-refresh-skills');
if (refreshSkillsBtn) refreshSkillsBtn.addEventListener('click', () => void renderInstalledSkills());
const clawhubLink = document.getElementById('link-clawhub');
if (clawhubLink) clawhubLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.clippy.openExternalUrl('https://clawhub.ai');
});
// Lazy-load installed skills when the Skills tab is opened (not on app launch)
// so we don't hit the disk on every Settings open.
let skillsLoadedOnce = false;
document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((item) => {
  if (item.dataset.section !== 'skills') return;
  item.addEventListener('click', () => {
    if (skillsLoadedOnce) return;
    skillsLoadedOnce = true;
    void renderInstalledSkills();
  });
});

// Mail Setup status display (Brain tab)
async function renderMailEnv(): Promise<void> {
  const el = document.getElementById('mail-env-status');
  if (!el || !window.clippy.mailEnvStatus) return;
  try {
    const env = await window.clippy.mailEnvStatus();
    if (!env) {
      el.textContent = 'Probe not yet run.';
      return;
    }
    const lines: string[] = [];
    lines.push(env.classic_outlook_com
      ? '<span style="color:#16a34a;">✓</span> Classic Outlook (COM)'
      : '<span style="color:#999;">✗</span> Classic Outlook (COM) — not installed');
    if (env.new_outlook_installed) {
      const olkOk = env.default_is_olk;
      lines.push(olkOk
        ? '<span style="color:#16a34a;">✓</span> New Outlook (olk) — default mail handler'
        : '<span style="color:#d97706;">⚠</span> New Outlook (olk) — installed, but NOT default mailto');
    } else {
      lines.push('<span style="color:#999;">✗</span> New Outlook (olk) — not installed');
    }
    if (env.default_mailto_handler) {
      lines.push(`<span style="color:#888;font-size:11px;">Default mailto: <code>${escapeHtml(env.default_mailto_handler)}</code></span>`);
    } else {
      lines.push('<span style="color:#888;font-size:11px;">No default mailto handler set.</span>');
    }
    el.innerHTML = lines.join('<br>');
  } catch {
    el.textContent = 'Probe unavailable.';
  }
}
void renderMailEnv();

// v0.15.0 — Settings → Web tab: mcp-chrome status display + refresh button
async function renderMcpChromeStatus(): Promise<void> {
  const el = document.getElementById('mcp-chrome-status');
  if (!el || !window.clippy.mcpChromeStatus) return;
  try {
    const s = await window.clippy.mcpChromeStatus();
    if (!s) { el.textContent = 'Probe not available.'; return; }
    if (s.ready) {
      const detectedAt = s.detected_at ? new Date(s.detected_at).toLocaleString() : '';
      el.innerHTML = `
        <span style="color:#16a34a;font-weight:600;">✓ Connected</span>
        <span style="color:#888;"> via ${escapeHtml(s.url)}</span><br>
        <span style="font-size:11px;color:#666;">${s.tool_count} tools available · detected ${escapeHtml(detectedAt)}</span><br>
        <span style="font-size:11px;color:#16a34a;">Clippy will use your real browser session for web tasks.</span>
      `;
    } else {
      el.innerHTML = `
        <span style="color:#d97706;font-weight:600;">⚠ Not detected</span>
        <span style="color:#888;"> at ${escapeHtml(s.url)}</span><br>
        <span style="font-size:11px;color:#666;">${escapeHtml(s.error || 'extension + bridge not connected')}</span><br>
        <span style="font-size:11px;color:#666;">Web tasks will use a spawned debug browser (fresh profile, no logins).</span>
      `;
    }
  } catch {
    el.textContent = 'Status check failed.';
  }
}
const mcpRefreshBtn = document.getElementById('btn-refresh-mcp-chrome');
if (mcpRefreshBtn) mcpRefreshBtn.addEventListener('click', async () => {
  if (window.clippy.mcpChromeRefresh) {
    (mcpRefreshBtn as HTMLButtonElement).disabled = true;
    await window.clippy.mcpChromeRefresh();
    await renderMcpChromeStatus();
    (mcpRefreshBtn as HTMLButtonElement).disabled = false;
  }
});
// v0.17.2 — replaced the bare github.com/hangwin/mcp-chrome links with
// our hosted install page at clippyai.app/extension. The user reported
// that pointing prospects at a third-party GitHub repo felt
// unprofessional and intimidating — terminal commands, dev-mode flipping,
// and an open-source repo logo all in the same flow. The hosted page on
// clippyai-web is a guided walkthrough with our branding and an inline
// "What this extension does + why it's safe" section.
const mcpChromeInstallLink = document.getElementById('link-mcp-chrome-install');
if (mcpChromeInstallLink) mcpChromeInstallLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.clippy.openExternalUrl('https://clippyai.app/extension');
});
// Lazy-load: probe when user opens the Web tab.
let webLoadedOnce = false;
document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((item) => {
  if (item.dataset.section !== 'web') return;
  item.addEventListener('click', () => {
    if (webLoadedOnce) return;
    webLoadedOnce = true;
    void renderMcpChromeStatus();
  });
});

// Active model display (About tab)
async function renderActiveModel(): Promise<void> {
  const el = document.getElementById('active-model');
  if (!el || !window.clippy.activeModel) return;
  try {
    const model = await window.clippy.activeModel();
    el.textContent = model || 'kimi (not yet served a turn)';
  } catch {
    el.textContent = 'unknown';
  }
}
void renderActiveModel();

// ─────────────────────────────────────────────────────────────────────
// v0.17.8 — Guardrails tab
// ─────────────────────────────────────────────────────────────────────

// Mirror of permission-policy.ts:ActionClass — kept in sync manually since
// the renderer is sandboxed and can't import main-process types directly.
// If you add a new class in tool-meta.ts, add a row to GUARDRAIL_CLASSES.
const GUARDRAIL_CLASSES: Array<{ id: string; label: string; desc: string }> = [
  { id: 'destructive_file',     label: 'File changes',      desc: 'Save, overwrite, rename, move, delete' },
  { id: 'destructive_send',     label: 'Send communication', desc: 'Email, calendar invites, messages' },
  { id: 'destructive_purchase', label: 'Purchases',         desc: 'Anything that commits money' },
  { id: 'share_public',         label: 'Public sharing',    desc: 'Post, tweet, file GitHub issue, share link' },
  { id: 'system_control',       label: 'System control',    desc: 'Kill processes, stop services' },
  { id: 'browser_navigate',     label: 'Browser navigation', desc: 'Open a URL or external link' },
  { id: 'desktop_input',        label: 'Cursor & keyboard',  desc: 'Synthesized clicks and key presses (visible)' },
];

const DECISION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',        label: 'Use policy default' },
  { value: 'allow',   label: 'Allow' },
  { value: 'approve', label: 'Ask first' },
  { value: 'block',   label: 'Block' },
];

async function loadGuardrails(): Promise<void> {
  if (!window.clippy.guardrails) return;
  const policy = await window.clippy.guardrails.getPolicy();
  document.querySelectorAll<HTMLInputElement>('input[name="permission-mode"]').forEach((r) => {
    r.checked = r.value === policy.mode;
    r.addEventListener('change', async () => {
      if (!r.checked || !window.clippy.guardrails) return;
      await window.clippy.guardrails.setPolicy({ mode: r.value as 'cautious' | 'standard' | 'trusted' });
    });
  });
  buildClassOverrides(policy.classOverrides);
  await refreshHistory();
}

function buildClassOverrides(current: Record<string, string>): void {
  const root = document.getElementById('class-overrides');
  if (!root) return;
  root.innerHTML = '';
  for (const cls of GUARDRAIL_CLASSES) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid #eee;border-radius:6px;background:#fff;';
    const left = document.createElement('div');
    left.innerHTML = `<div style="font-size:12.5px;font-weight:600;color:#1a1a1a;">${cls.label}</div><div style="font-size:11px;color:#777;">${cls.desc}</div>`;
    const select = document.createElement('select');
    select.style.cssText = 'font-size:12px;padding:4px 8px;border:1px solid #d0d4da;border-radius:4px;background:#fff;';
    for (const opt of DECISION_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if ((current[cls.id] ?? '') === opt.value) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', async () => {
      if (!window.clippy.guardrails) return;
      // Send the full overrides object so the main side replaces cleanly.
      const overrides: Record<string, 'allow' | 'approve' | 'block'> = {};
      document.querySelectorAll<HTMLSelectElement>('#class-overrides select').forEach((s, i) => {
        const v = s.value;
        if (v) overrides[GUARDRAIL_CLASSES[i].id] = v as 'allow' | 'approve' | 'block';
      });
      await window.clippy.guardrails.setPolicy({ classOverrides: overrides });
    });
    row.appendChild(left);
    row.appendChild(select);
    root.appendChild(row);
  }
}

function fmtRelTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return Math.max(1, Math.round(diff / 1000)) + 's ago';
  if (diff < 3_600_000) return Math.round(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + 'h ago';
  return Math.round(diff / 86_400_000) + 'd ago';
}

function outcomeBadge(o: string): string {
  const map: Record<string, [string, string]> = {
    success:         ['#107c41', '✓'],
    failure:         ['#c53030', '✗'],
    unverified:      ['#b76b00', '?'],
    blocked:         ['#888',    '⊘'],
    approval_denied: ['#888',    '✗'],
  };
  const [color, glyph] = map[o] || ['#888', '·'];
  return `<span style="color:${color};font-weight:700;margin-right:6px;">${glyph}</span>`;
}

async function refreshHistory(): Promise<void> {
  if (!window.clippy.guardrails) return;
  const rows = await window.clippy.guardrails.getHistory();
  const root = document.getElementById('action-history-list');
  if (!root) return;
  const empty = document.getElementById('action-history-empty');
  if (!rows || rows.length === 0) {
    if (empty) empty.style.display = '';
    // Clear any stale rendered rows
    Array.from(root.querySelectorAll('.action-row')).forEach((n) => n.remove());
    return;
  }
  if (empty) empty.style.display = 'none';
  Array.from(root.querySelectorAll('.action-row')).forEach((n) => n.remove());
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'action-row';
    div.style.cssText = 'display:grid;grid-template-columns:18px 1fr auto;gap:6px;padding:6px 10px;border-bottom:1px solid #eef0f3;align-items:start;';
    const escTool = String(r.tool).replace(/[<>&]/g, '');
    const escDetail = String(r.detail || '').replace(/[<>&]/g, '');
    const escClass = r.actionClass ? `<span style="color:#888;margin-left:6px;font-size:10.5px;">·${r.actionClass}·T${r.tier}</span>` : `<span style="color:#888;margin-left:6px;font-size:10.5px;">·T${r.tier}</span>`;
    div.innerHTML = `
      ${outcomeBadge(r.outcome)}
      <div style="overflow:hidden;">
        <div style="color:#1a1a1a;font-weight:600;font-size:11.5px;">${escTool}${escClass}</div>
        <div style="color:#555;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escDetail}</div>
      </div>
      <div style="color:#888;font-size:10.5px;white-space:nowrap;">${fmtRelTime(r.ts)}</div>
    `;
    root.appendChild(div);
  }
}

document.getElementById('btn-clear-history')?.addEventListener('click', async () => {
  if (!window.clippy.guardrails) return;
  if (!confirm('Clear the activity log? This only deletes the in-app history; your real logs stay.')) return;
  await window.clippy.guardrails.clearHistory();
  await refreshHistory();
});

// Lazy-load Guardrails when tab opens — keeps the settings window snappy on cold start.
let guardrailsLoadedOnce = false;
document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((item) => {
  if (item.dataset.section !== 'guardrails') return;
  item.addEventListener('click', () => {
    if (guardrailsLoadedOnce) {
      // Refresh history on re-entry so new actions show up.
      void refreshHistory();
      return;
    }
    guardrailsLoadedOnce = true;
    void loadGuardrails();
  });
});

// Init
loadConfig();
testConnection();
