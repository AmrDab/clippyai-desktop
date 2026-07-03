// Window.clippy types live in src/preload/api.d.ts (single source of truth).
export {};

// Hotkeys are now rendered as static macOS glyphs in settings.html (the
// .s-keycap rows) and the engine picker is hidden until real engine-
// switching ships, so the old runtime platform-relabel pass is no longer
// needed. macOS is the only supported platform for this build.

// Nav switching
const navItems = document.querySelectorAll<HTMLElement>('.settings-nav-item');
const sections = document.querySelectorAll<HTMLElement>('.settings-section');

navItems.forEach((item) => {
  item.addEventListener('click', () => {
    const target = item.dataset.section!;
    navItems.forEach((n) => {
      const selected = n === item;
      n.classList.toggle('active', selected);
      n.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    sections.forEach((s) => s.classList.toggle('active', s.dataset.section === target));
  });
});

// Elements
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

  // v0.19.0 — load Clippy energy radio buttons
  const energyVal = (config.clippyEnergy as string) || 'default';
  const energyRadio = document.querySelector<HTMLInputElement>(
    `input[name="clippy-energy"][value="${energyVal}"]`,
  );
  if (energyRadio) energyRadio.checked = true;

  if (config.ttsVoice) {
    voiceSelect.value = config.ttsVoice as string;
  }

  // TTS enabled toggle + speech rate
  const ttsEl = document.getElementById('setting-tts-enabled') as HTMLInputElement;
  if (ttsEl) ttsEl.checked = config.ttsEnabled !== false; // default true

  // v0.20.0 (voice v1) — TTS engine picker + OpenAI key presence. The key
  // value is never sent here; we only learn whether one is stored.
  const engineSel = document.getElementById('setting-tts-engine') as HTMLSelectElement | null;
  if (engineSel) engineSel.value = config.ttsEngine === 'openai' ? 'openai' : 'system';
  openAiKeyPresent = config.openaiKeyPresent === true;
  renderOpenAiKeyStatus();
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
      sttStatusEl.classList.remove('s-status--ok', 's-status--error');
      if (s.ready) {
        // Voice input is transcribed locally on-device by the bundled
        // whisper.cpp binary (whisper-cli) — see preload transcribeAudio →
        // 'transcribe-audio'. Audio never leaves the machine.
        sttStatusEl.textContent = '✓ Voice input ready — transcribed on-device (whisper.cpp); audio stays local.';
        sttStatusEl.classList.add('s-status--ok');
      } else {
        sttStatusEl.textContent = `✗ Voice unavailable: ${s.reason || 'unknown'}`;
        sttStatusEl.classList.add('s-status--error');
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

  // v0.19.0 — follow-me cursor mode settings
  const fxEl = document.getElementById('setting-follow-offset-x') as HTMLInputElement | null;
  const fxValEl = document.getElementById('follow-offset-x-value');
  if (fxEl && fxValEl && config.followOffsetX !== undefined) {
    fxEl.value = String(config.followOffsetX);
    fxValEl.textContent = `${config.followOffsetX}px`;
  }
  const fyEl = document.getElementById('setting-follow-offset-y') as HTMLInputElement | null;
  const fyValEl = document.getElementById('follow-offset-y-value');
  if (fyEl && fyValEl && config.followOffsetY !== undefined) {
    fyEl.value = String(config.followOffsetY);
    fyValEl.textContent = `${config.followOffsetY}px`;
  }
  const feEl = document.getElementById('setting-follow-easing') as HTMLInputElement | null;
  const feValEl = document.getElementById('follow-easing-value');
  if (feEl && feValEl && config.followEasing !== undefined) {
    feEl.value = String(config.followEasing);
    feValEl.textContent = String(parseFloat(String(config.followEasing)).toFixed(2));
  }

  // v0.20.0-alpha.11 — focused-window follow toggle. Default ON; users who
  // dislike auto-repositioning can disable.
  const wfEl = document.getElementById('setting-window-follow') as HTMLInputElement | null;
  if (wfEl) {
    wfEl.checked = config.windowFollowEnabled !== false; // default true
    wfEl.addEventListener('change', () => {
      window.clippy.updateSettings({ windowFollowEnabled: wfEl.checked });
    });
  }

  // v0.20.0 (Beta) — writing-assistant toggle (⌥G).
  const waEl = document.getElementById('setting-writing-assist') as HTMLInputElement | null;
  if (waEl) {
    waEl.checked = config.writingAssistEnabled !== false; // default true
    waEl.addEventListener('change', () => {
      window.clippy.updateSettings({ writingAssistEnabled: waEl.checked });
    });
  }

  // Launch on startup
  const launchEl = document.getElementById('setting-launch-startup') as HTMLInputElement;
  if (launchEl) launchEl.checked = Boolean(config.launchOnStartup);

  // v0.20.0-alpha.5 — Your name (read from user.md profile, not config).
  // Previously the only way to edit / clear the saved Name was to wipe
  // user.md by hand. Onboarding could capture garbage ("Hey", "Hello") and
  // the user had no recourse from inside the app.
  const nameEl = document.getElementById('setting-user-name') as HTMLInputElement | null;
  if (nameEl) {
    try {
      const profile = await window.clippy.getUserProfile();
      nameEl.value = (profile && typeof profile.Name === 'string') ? profile.Name : '';
    } catch { /* best-effort; leave field empty */ }
  }

  // License
  const key = (config.licenseKey as string) || '';
  licenseKeyDisplay.textContent = key ? maskKey(key) : 'No key set';
  const planName = (config.plan as string) || 'Unknown';
  licensePlanDisplay.textContent = planName;
  showPlanFeatures(planName);
  renderUsageMeter(planName, config);
  renderUpgradeCta(planName);
}

// ── Stripe checkout URLs ─────────────────────────────────────────────────────
// Single source of truth for this renderer module. Onboarding + main.ts each
// keep their own local copies (they are separate bundles); keep in sync if the
// links ever rotate.
const STRIPE_POWER = 'https://buy.stripe.com/8x2bJ06jXfC65XDe2Oe3e03'; // $19.99/mo
const STRIPE_MAX   = 'https://buy.stripe.com/5kQaEW7o1cpUdq52k6e3e05'; // $39.99/mo

// feat/pricing-free-tier — monthly usage meter for free-tier users. Reads the
// usage snapshot (tokensUsed / tokensAllowed) the worker stamps on every /turn
// response and main persists. Paid tiers (and unknown plans) hide the meter.
function renderUsageMeter(plan: string, config: Record<string, unknown>): void {
  const row = document.getElementById('usage-meter-row');
  if (!row) return;
  const lower = (plan || '').toLowerCase();
  const used = Number(config.tokensUsed) || 0;
  const allowed = Number(config.tokensAllowed) || 0;
  // Show only for the free tier, and only once we've seen a real ceiling.
  if (lower !== 'free' || allowed <= 0) { row.style.display = 'none'; return; }
  const pct = Math.min(100, Math.round((used / allowed) * 100));
  const near = pct >= 85;
  const fill = document.getElementById('usage-meter-fill');
  const track = document.getElementById('usage-meter-track');
  const text = document.getElementById('usage-meter-text');
  const upgradeLink = document.getElementById('usage-upgrade-link') as HTMLAnchorElement | null;
  if (fill) {
    fill.style.width = `${pct}%`;
    // Warm the bar as it fills: blue → amber near the limit.
    fill.style.background = near ? 'var(--tint-warning,#f59e0b)' : 'var(--tint-accent,#3b82f6)';
  }
  if (track) track.setAttribute('aria-valuenow', String(pct));
  // Convey "near limit" with an icon + words, not color alone (WCAG 1.4.1).
  if (text) text.textContent = near
    ? `⚠ ${pct}% of your free tokens used this month — nearing your limit`
    : `${pct}% of your free tokens used this month`;
  row.style.display = 'flex';
  if (upgradeLink) {
    upgradeLink.style.display = near ? 'inline' : 'none';
    if (!upgradeLink.dataset.wired) {
      upgradeLink.dataset.wired = '1';
      upgradeLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.clippy.openExternalUrl(STRIPE_POWER);
      });
    }
  }
}

// feat/pricing-max — show a contextual Max upgrade CTA depending on plan:
//   free  → "Upgrade to Max" (Max is the premium option; Power CTA lives in the
//            usage-meter row which only appears when near the token cap).
//   power → "Upgrade to Max — premium voice, deeper reasoning, 20M tokens"
//   max   → hide (already on top tier)
function renderUpgradeCta(plan: string): void {
  const el = document.getElementById('upgrade-to-max-row');
  if (!el) return;
  const lower = (plan || '').toLowerCase();
  if (lower === 'max') { el.style.display = 'none'; return; }
  el.style.display = '';
  const link = el.querySelector<HTMLAnchorElement>('#upgrade-to-max-link');
  if (link && !link.dataset.wired) {
    link.dataset.wired = '1';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.clippy.openExternalUrl(STRIPE_MAX);
    });
  }
  // Tailor the label for Power users.
  if (link) {
    link.textContent = lower === 'power'
      ? 'Upgrade to Max — premium voice, deeper reasoning, 20M tokens →'
      : 'Upgrade to Max →';
  }
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

// Buddy-name input was removed in fix/orientation-not-name — Clippy is
// always named "Clippy". The config key remains in the store for back-
// compat (read by tray.ts, brain.ts) but is no longer user-editable.

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

// v0.20.0 (voice v1) — TTS engine picker (System free / OpenAI premium) +
// the user-provided OpenAI key field. The key is write-only: we store it
// via main (Keychain) and only ever read back a presence boolean — the UI
// never sees the key value. Picking OpenAI without a stored key is allowed
// but warned about; tts.ts falls back to System until a key is saved.
const ttsEngineSelect = document.getElementById('setting-tts-engine') as HTMLSelectElement | null;
const openaiKeyInput = document.getElementById('setting-openai-key') as HTMLInputElement | null;
const openaiKeyStatus = document.getElementById('openai-key-status');
const saveOpenAiKeyBtn = document.getElementById('btn-save-openai-key') as HTMLButtonElement | null;
const clearOpenAiKeyBtn = document.getElementById('btn-clear-openai-key') as HTMLButtonElement | null;
const openaiKeysLink = document.getElementById('link-openai-keys');
let openAiKeyPresent = false;

function renderOpenAiKeyStatus(): void {
  if (!openaiKeyStatus) return;
  if (openAiKeyPresent) {
    openaiKeyStatus.textContent = 'A key is saved in your macOS Keychain. It stays on this Mac and is sent only to OpenAI when you use OpenAI voice. Use Remove to delete it.';
  } else {
    openaiKeyStatus.textContent = 'No key saved. OpenAI voice needs your own key — stored securely in macOS Keychain, sent only to OpenAI. Get one at platform.openai.com/api-keys.';
  }
  // OpenAI selected but no key → make the missing-key state obvious.
  if (ttsEngineSelect && ttsEngineSelect.value === 'openai' && !openAiKeyPresent) {
    openaiKeyStatus.textContent = 'OpenAI selected but no key saved — Clippy will use the System voice until you save a key below.';
  }
}

if (ttsEngineSelect) {
  ttsEngineSelect.addEventListener('change', () => {
    const engine = ttsEngineSelect.value === 'openai' ? 'openai' : 'system';
    window.clippy.updateSettings({ ttsEngine: engine });
    renderOpenAiKeyStatus();
  });
}

if (saveOpenAiKeyBtn && openaiKeyInput) {
  saveOpenAiKeyBtn.addEventListener('click', async () => {
    const token = openaiKeyInput.value.trim();
    if (token.length < 8) {
      if (openaiKeyStatus) openaiKeyStatus.textContent = 'That key looks too short. Paste your full OpenAI key (starts with "sk-").';
      return;
    }
    const res = await window.clippy.setOpenAiKey?.(token);
    if (res && res.ok) {
      openAiKeyPresent = true;
      openaiKeyInput.value = '';
      renderOpenAiKeyStatus();
    } else if (openaiKeyStatus) {
      openaiKeyStatus.textContent = `Could not save key: ${res?.error || 'unknown error'}.`;
    }
  });
}

if (clearOpenAiKeyBtn) {
  clearOpenAiKeyBtn.addEventListener('click', async () => {
    const res = await window.clippy.clearOpenAiKey?.();
    if (res && res.ok) {
      openAiKeyPresent = false;
      // main reverts the engine to System; reflect that in the picker.
      if (ttsEngineSelect) ttsEngineSelect.value = 'system';
      renderOpenAiKeyStatus();
    }
  });
}

if (openaiKeysLink) openaiKeysLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.clippy.openExternalUrl('https://platform.openai.com/api-keys');
});

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
//
// v0.18.4 — also read pitch + volume from the live sliders. Pre-fix the
// click handler set only utterance.rate, so dragging the pitch or
// volume sliders and clicking Play Sample silently used browser
// defaults (pitch=1.0, volume=1.0). Real Clippy speech via tts.ts was
// always correct because the IPC speech-pitch / speech-volume channels
// flow live to the bubble renderer — this bug was confined to the
// Settings preview button.
const testVoiceBtn = document.getElementById('btn-test-voice') as HTMLButtonElement | null;
if (testVoiceBtn) {
  testVoiceBtn.addEventListener('click', () => {
    try {
      const utterance = new SpeechSynthesisUtterance('Hi! I\'m Clippy, your AI desktop assistant.');
      const voices = window.speechSynthesis.getVoices();
      const selected = voices.find((v) => v.name === voiceSelect.value);
      if (selected) utterance.voice = selected;
      utterance.rate = Number(speechRateRange.value) || 1.1;
      if (pitchRange) utterance.pitch = Number(pitchRange.value) || 1.0;
      if (volumeRange) utterance.volume = Number(volumeRange.value) ?? 0.9;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch { /* SpeechSynthesis unavailable — silent fail */ }
  });
}

// v0.19.0 — Clippy energy radio cards
const energyGroup = document.getElementById('clippy-energy-group');
if (energyGroup) {
  energyGroup.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement | null;
    if (target && target.name === 'clippy-energy') {
      window.clippy.updateSettings({ clippyEnergy: target.value });
    }
  });
}

// Launch on startup toggle
const launchToggle = document.getElementById('setting-launch-startup') as HTMLInputElement;
if (launchToggle) {
  launchToggle.addEventListener('change', () => {
    window.clippy.setLaunchOnStartup(launchToggle.checked);
  });
}

// v0.20.0-alpha.5 — Your name input. Persists to user.md via saveUserProfile.
// Saves on blur (commit) AND on input debounced 500ms (live). Empty string is
// a valid value — it clears the saved Name so Clippy addresses generically.
const userNameInput = document.getElementById('setting-user-name') as HTMLInputElement | null;
if (userNameInput) {
  let nameSaveTimer: number | null = null;
  const saveName = (): void => {
    const v = userNameInput.value.trim();
    void window.clippy.saveUserProfile({ Name: v });
  };
  userNameInput.addEventListener('input', () => {
    if (nameSaveTimer) clearTimeout(nameSaveTimer);
    nameSaveTimer = window.setTimeout(saveName, 500);
  });
  userNameInput.addEventListener('blur', () => {
    if (nameSaveTimer) { clearTimeout(nameSaveTimer); nameSaveTimer = null; }
    saveName();
  });
}

// Manage Subscription link
const manageSubLink = document.getElementById('manage-subscription');
if (manageSubLink) {
  let manageSubBusy = false;
  manageSubLink.addEventListener('click', async (e) => {
    e.preventDefault();
    if (manageSubBusy) return; // ignore rapid re-clicks; else 'Opening…' is captured as prev
    manageSubBusy = true;
    const prev = manageSubLink.textContent;
    manageSubLink.textContent = 'Opening…';
    // openSubscriptionPortal returns false for promo/free keys (no Stripe
    // billing portal), invalid keys, or a network timeout. Previously the
    // return was ignored, so the link silently did nothing — a dead-end for
    // every free/promo user. Surface a clear next step on failure.
    let ok = false;
    try { ok = await window.clippy.openSubscriptionPortal(); } catch { ok = false; }
    manageSubLink.textContent = prev;
    let note = document.getElementById('manage-sub-note');
    if (!ok) {
      if (!note) {
        note = document.createElement('div');
        note.id = 'manage-sub-note';
        note.className = 's-row__help';
        note.style.color = 'var(--s-danger,#dc2626)';
        note.style.marginTop = 'var(--s-space-2)';
        manageSubLink.parentElement?.appendChild(note);
      }
      note.textContent = "Billing portal isn't available for this plan. Email hello@clippyai.app to manage your subscription.";
    } else if (note) {
      note.remove();
    }
    manageSubBusy = false;
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

// Reset ClippyAI (Danger zone) — full local wipe + relaunch into onboarding.
// The confirm prompt and the wipe both live in main (native dialog); on
// confirm the app relaunches, so nothing after this runs.
const btnResetApp = document.getElementById('btn-reset-app');
if (btnResetApp) {
  btnResetApp.addEventListener('click', () => {
    void window.clippy.resetApp?.();
  });
}

// Plan features display
const PLAN_FEATURES_MAP: Record<string, string[]> = {
  free: ['Chat & questions', 'Web-grounded answers', '100K tokens/month'],
  power: ['Everything in Free', 'Desktop automation', 'Browser control', 'Multi-monitor', 'Custom personas', 'Priority support', '5M tokens/month'],
  max: ['Everything in Power', 'Premium voice (600 min/mo)', 'Smarter brain (deep reasoning)', 'Early access', '20M tokens/month'],
  // Legacy tiers — retained so users on grandfathered plans still see a sane list.
  basic: ['Chat & questions', 'Web-grounded answers', '500K tokens/month'],
  pro: ['Everything in Basic', 'Desktop automation', 'Browser control', '2M tokens/month'],
};

function showPlanFeatures(plan: string): void {
  const el = document.getElementById('plan-features');
  if (!el) return;
  const lower = (plan || 'free').toLowerCase();
  const features = PLAN_FEATURES_MAP[lower] || PLAN_FEATURES_MAP.free;
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
    lines.push(env.apple_mail_installed
      ? '<span style="color:#16a34a;">✓</span> Apple Mail'
      : '<span style="color:#999;">✗</span> Apple Mail — not installed');
    if (env.outlook_mac_installed) {
      const olkOk = env.default_is_outlook;
      lines.push(olkOk
        ? '<span style="color:#16a34a;">✓</span> Outlook for Mac — default mail handler'
        : '<span style="color:#d97706;">⚠</span> Outlook for Mac — installed, but NOT default mailto');
    } else {
      lines.push('<span style="color:#999;">✗</span> Outlook for Mac — not installed');
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
    el.textContent = model || '(no turn served yet)';
  } catch {
    el.textContent = 'unknown';
  }
}
void renderActiveModel();

// v0.19.0 — follow-me cursor mode sliders
const followOffsetXRange = document.getElementById('setting-follow-offset-x') as HTMLInputElement | null;
const followOffsetXValue = document.getElementById('follow-offset-x-value');
if (followOffsetXRange && followOffsetXValue) {
  followOffsetXRange.addEventListener('input', () => {
    followOffsetXValue.textContent = `${followOffsetXRange.value}px`;
    debounceSave({ followOffsetX: Number(followOffsetXRange.value) });
  });
}
const followOffsetYRange = document.getElementById('setting-follow-offset-y') as HTMLInputElement | null;
const followOffsetYValue = document.getElementById('follow-offset-y-value');
if (followOffsetYRange && followOffsetYValue) {
  followOffsetYRange.addEventListener('input', () => {
    followOffsetYValue.textContent = `${followOffsetYRange.value}px`;
    debounceSave({ followOffsetY: Number(followOffsetYRange.value) });
  });
}
const followEasingRange = document.getElementById('setting-follow-easing') as HTMLInputElement | null;
const followEasingValue = document.getElementById('follow-easing-value');
if (followEasingRange && followEasingValue) {
  followEasingRange.addEventListener('input', () => {
    followEasingValue.textContent = String(parseFloat(followEasingRange.value).toFixed(2));
    debounceSave({ followEasing: Number(followEasingRange.value) });
  });
}

// ── v0.19.0 — Guardrails: permission policy + activity log ────────────────

/** Format a timestamp as a relative string (e.g. "2m ago", "just now"). */
function fmtRelTime(ts: string): string {
  try {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch {
    return ts;
  }
}

function outcomeBadge(outcome: string): string {
  const color = outcome === 'success' ? '#16a34a' : outcome === 'failure' ? '#dc2626' : outcome === 'blocked' ? '#9333ea' : '#d97706';
  const label = outcome === 'success' ? '✓' : outcome === 'failure' ? '✗' : outcome === 'blocked' ? '⊘' : '~';
  return `<span title="${outcome}" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:${color};color:#fff;font-size:9px;font-weight:700;flex-shrink:0;">${label}</span>`;
}

async function refreshHistory(): Promise<void> {
  const root = document.getElementById('action-history-list');
  const empty = document.getElementById('action-history-empty');
  if (!root || !window.clippy.guardrails) return;
  try {
    const rows = await window.clippy.guardrails.getHistory();
    if (!rows || rows.length === 0) {
      if (empty) empty.style.display = '';
      root.querySelectorAll('.action-row').forEach((el) => el.remove());
      return;
    }
    if (empty) empty.style.display = 'none';
    root.querySelectorAll('.action-row').forEach((el) => el.remove());

    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'action-row';
      div.style.cssText = 'display:grid;grid-template-columns:18px 1fr auto;gap:6px;padding:6px 10px;border-bottom:1px solid #eef0f3;align-items:start;';
      const escTool = String(r.tool).replace(/[<>&]/g, '');
      const escDetail = String(r.detail || '').replace(/[<>&]/g, '');
      const escClass = r.actionClass
        ? `<span style="color:#888;margin-left:6px;font-size:10.5px;">·${r.actionClass}·T${r.tier}</span>`
        : `<span style="color:#888;margin-left:6px;font-size:10.5px;">·T${r.tier}</span>`;

      let rightCol: string;
      if (r.undone) {
        const undoneAtStr = r.undoneAt ? new Date(r.undoneAt).toLocaleTimeString() : '';
        rightCol = `<span class="undo-badge undo-done" title="Undone at ${undoneAtStr}" style="background:#d1fae5;color:#065f46;border-radius:4px;padding:2px 7px;font-size:10.5px;font-weight:600;white-space:nowrap;">Undone</span>`;
      } else if (r.inverse && r.inverse.kind === 'noop') {
        const reason = String(r.inverse.reason || '').replace(/"/g, '&quot;');
        rightCol = `<span class="undo-badge undo-noop" title="${reason}" style="background:#f3f4f6;color:#9ca3af;border-radius:4px;padding:2px 7px;font-size:10.5px;font-weight:500;white-space:nowrap;cursor:help;">Can\'t undo</span>`;
      } else if (r.inverse) {
        rightCol = `<button class="undo-btn" data-id="${r.id}" style="background:#fff;border:1px solid #d0d4da;border-radius:4px;padding:2px 8px;font-size:10.5px;cursor:pointer;color:#374151;white-space:nowrap;" title="Undo this action">Undo</button>`;
      } else {
        rightCol = `<div style="color:#888;font-size:10.5px;white-space:nowrap;">${fmtRelTime(r.ts)}</div>`;
      }

      div.innerHTML = `
        ${outcomeBadge(r.outcome)}
        <div style="overflow:hidden;">
          <div style="color:#1a1a1a;font-weight:600;font-size:11.5px;">${escTool}${escClass}</div>
          <div style="color:#555;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escDetail}">${escDetail}</div>
          <div style="color:#aaa;font-size:10px;margin-top:1px;">${fmtRelTime(r.ts)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">${rightCol}</div>
      `;

      const undoBtn = div.querySelector<HTMLButtonElement>('.undo-btn');
      if (undoBtn) {
        undoBtn.addEventListener('click', async () => {
          undoBtn.disabled = true;
          undoBtn.textContent = 'Undoing...';
          try {
            const result = await clickUndo(undoBtn.dataset.id ?? '');
            if (result.ok) {
              const parent = undoBtn.parentElement;
              if (parent) {
                parent.innerHTML = `<span class="undo-badge undo-done" style="background:#d1fae5;color:#065f46;border-radius:4px;padding:2px 7px;font-size:10.5px;font-weight:600;">Undone</span>`;
              }
            } else {
              undoBtn.disabled = false;
              undoBtn.textContent = 'Undo';
              alert(`Undo failed: ${result.detail || 'Unknown error'}`);
            }
          } catch {
            undoBtn.disabled = false;
            undoBtn.textContent = 'Undo';
          }
        });
      }

      root.appendChild(div);
    }
  } catch (err) {
    if (empty) { empty.textContent = `Failed to load history: ${err instanceof Error ? err.message : String(err)}`; empty.style.display = ''; }
  }
}

async function clickUndo(id: string): Promise<{ ok: boolean; detail?: string }> {
  if (!id || !window.clippy.guardrails) return { ok: false, detail: 'Not available.' };
  try {
    return await window.clippy.guardrails.undoAction(id);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

document.getElementById('btn-clear-history')?.addEventListener('click', async () => {
  if (!window.clippy.guardrails) return;
  if (!confirm('Clear the activity log? This only deletes the in-app history; your real logs stay.')) return;
  await window.clippy.guardrails.clearHistory();
  await refreshHistory();
});

async function loadGuardrails(): Promise<void> {
  if (!window.clippy.guardrails) return;
  try {
    const policy = await window.clippy.guardrails.getPolicy();
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="permission-mode"]');
    radios.forEach((r) => { r.checked = r.value === policy.mode; });
    radios.forEach((r) => {
      r.addEventListener('change', async () => {
        if (r.checked && window.clippy.guardrails) {
          await window.clippy.guardrails.setPolicy({ mode: r.value as 'cautious' | 'standard' | 'trusted' });
        }
      });
    });
  } catch { /* non-fatal */ }
}

let guardrailsLoadedOnce = false;
document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((item) => {
  if (item.dataset.section !== 'guardrails') return;
  item.addEventListener('click', () => {
    if (!guardrailsLoadedOnce) {
      guardrailsLoadedOnce = true;
      void loadGuardrails();
      void refreshHistory();
    }
  });
});

// Init
loadConfig();
testConnection();

// ═══════════════════════════════════════════════════════════════════════
// v0.19.0 PR-6 — Settings → Apps tab.
//
// Same picker + key-entry UI as onboarding steps 4 and 5, just rendered
// inside the settings window. Persistence path is identical:
//   - userApps[] → licenseStore via window.clippy.setUserApps
//   - per-app tokens → macOS Keychain via window.clippy.setApiKey
//   - per-app PRESENCE flag → licenseStore (NOT raw token) so tools.ts
//     can do a sync hasApiKey() check without a keychain hit on every
//     tool call.
//
// Behavioral diff vs onboarding:
//   - In onboarding, the Save happens on step-transition (next button).
//   - In Settings, the user expects autosave — toggling an app or
//     pasting a token persists on the spot. We debounce token writes
//     by 600ms so a fast typer doesn't fan 20 keychain writes.
// ═══════════════════════════════════════════════════════════════════════

import { APP_CATALOG, APP_BY_ID } from './app-catalog';
type AppCatalogEntryLite = {
  id: string;
  name: string;
  hasApi: boolean;
  iconSvg: string;
  apiInstructions?: string;
};

// Set data-platform on the settings body — same bootstrap as onboarding.
(function setPlatformForSettings(): void {
  const p = (navigator.platform || '').toLowerCase();
  if (p.includes('mac')) document.body.setAttribute('data-platform', 'mac');
  else if (p.includes('win')) document.body.setAttribute('data-platform', 'win');
  else document.body.setAttribute('data-platform', 'other');
})();

const settingsSelectedApps = new Set<string>();
const settingsApiKeyPresent = new Map<string, boolean>();
const tokenWriteTimers = new Map<string, number>();
let appsTabLoaded = false;

async function loadAppsTab(): Promise<void> {
  if (appsTabLoaded) return; // first-touch only; subsequent re-opens
  appsTabLoaded = true;       // already have current state
  try {
    const apps = await window.clippy.getUserApps?.();
    if (Array.isArray(apps)) for (const id of apps) settingsSelectedApps.add(id);
    const keys = await window.clippy.getApiKeys?.();
    if (keys) for (const [id, present] of Object.entries(keys)) settingsApiKeyPresent.set(id, !!present);
  } catch { /* defaults: empty set, no keys */ }
  renderSettingsAppPicker();
  renderSettingsApiKeys();
}

function renderSettingsAppPicker(): void {
  const root = document.getElementById('settings-app-picker');
  if (!root) return;
  root.innerHTML = '';
  // v0.20.0-alpha.3 — Settings → Apps shows ONLY apps that have an API path
  // (hasApi: true). The full 19-app onboarding catalog includes Apple Mail,
  // Apple Notes, Safari, Apple Calendar, etc. that don't expose a token
  // connection — for those, the user can't "connect" anything from this
  // panel (Clippy reaches them via AppleScript / the macOS bridge). Showing
  // them in the Settings "Connected Apps" panel was confusing — the cards
  // toggled but produced no token row. Filtering to hasApi:true here
  // matches what the API-key section can render, so toggle ↔ row is 1:1.
  // The full picker stays in onboarding step 4 where the broader set of
  // "what apps do you use" still matters for screen-context hints.
  for (const group of APP_CATALOG) {
    const apiApps = group.apps.filter((app) => app.hasApi);
    if (apiApps.length === 0) continue;  // skip groups with no API-capable apps
    const groupEl = document.createElement('div');
    groupEl.className = 'app-group';
    const label = document.createElement('div');
    label.className = 'app-group-label';
    label.textContent = group.label;
    groupEl.appendChild(label);
    const grid = document.createElement('div');
    grid.className = 'app-grid';
    for (const app of apiApps) {
      grid.appendChild(makeSettingsAppCard(app));
    }
    groupEl.appendChild(grid);
    root.appendChild(groupEl);
  }
}

function makeSettingsAppCard(app: AppCatalogEntryLite): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'app-card';
  btn.dataset.appId = app.id;
  btn.setAttribute('aria-pressed', String(settingsSelectedApps.has(app.id)));
  if (settingsSelectedApps.has(app.id)) btn.classList.add('selected');

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
  check.textContent = '✓';
  btn.appendChild(check);

  btn.addEventListener('click', async () => {
    if (settingsSelectedApps.has(app.id)) {
      settingsSelectedApps.delete(app.id);
      btn.classList.remove('selected');
      btn.setAttribute('aria-pressed', 'false');
    } else {
      settingsSelectedApps.add(app.id);
      btn.classList.add('selected');
      btn.setAttribute('aria-pressed', 'true');
    }
    // Autosave on toggle. setUserApps re-validates against the whitelist
    // in main; we just send what we've got and trust the clamp.
    try {
      await window.clippy.setUserApps?.(Array.from(settingsSelectedApps));
      flashSaveStatus('Saved');
    } catch {
      flashSaveStatus('Save failed — try again');
    }
    renderSettingsApiKeys();
  });

  return btn;
}

function renderSettingsApiKeys(): void {
  const root = document.getElementById('settings-api-keys');
  const empty = document.getElementById('settings-api-keys-empty');
  if (!root || !empty) return;
  root.innerHTML = '';
  const apiCapable = Array.from(settingsSelectedApps)
    .map((id) => APP_BY_ID[id])
    .filter((app): app is AppCatalogEntryLite => !!app && app.hasApi);
  if (apiCapable.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  for (const app of apiCapable) {
    root.appendChild(makeSettingsKeyRow(app));
  }
}

function makeSettingsKeyRow(app: AppCatalogEntryLite): HTMLElement {
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
  // Status pill — "Connected" if we have a token in keychain, otherwise idle.
  const status = document.createElement('span');
  status.className = 'api-key-status';
  if (settingsApiKeyPresent.get(app.id)) {
    status.classList.add('set');
    status.textContent = '✓ Connected';
  } else {
    status.textContent = 'Not connected';
  }
  head.appendChild(status);
  row.appendChild(head);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'key-row-input-wrap';
  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'key-row-input';
  input.placeholder = settingsApiKeyPresent.get(app.id)
    ? `••••••••  (stored in Keychain — paste here to replace)`
    : `Paste your ${app.name} token`;
  input.autocomplete = 'off';
  input.spellcheck = false;
  inputWrap.appendChild(input);
  row.appendChild(inputWrap);

  // Debounced autosave. 600ms after last keystroke we attempt the write.
  // If the input is empty we don't fire — empty doesn't mean "clear", it
  // means "no change". To explicitly clear, use the Disconnect link.
  input.addEventListener('input', () => {
    const existing = tokenWriteTimers.get(app.id);
    if (existing) window.clearTimeout(existing);
    const t = window.setTimeout(async () => {
      const val = input.value.trim();
      if (!val) return;
      try {
        const r = await window.clippy.setApiKey?.(app.id, val);
        if (r && r.ok) {
          settingsApiKeyPresent.set(app.id, true);
          status.classList.add('set');
          status.textContent = '✓ Connected';
          input.value = '';
          input.placeholder = `••••••••  (stored in Keychain — paste here to replace)`;
          flashSaveStatus(`${app.name} connected`);
        } else {
          flashSaveStatus(`${app.name}: ${r?.error || 'save failed'}`);
        }
      } catch {
        flashSaveStatus(`${app.name} save failed`);
      }
    }, 600);
    tokenWriteTimers.set(app.id, t);
  });

  const footer = document.createElement('div');
  footer.className = 'key-row-footer';

  if (settingsApiKeyPresent.get(app.id)) {
    const disconnect = document.createElement('button');
    disconnect.type = 'button';
    disconnect.className = 'key-row-link';
    disconnect.textContent = 'Disconnect';
    disconnect.addEventListener('click', async () => {
      // Confirm because this wipes the keychain entry — not destructive
      // (user can re-paste) but the action is opaque enough to warrant
      // a confirmation per HIG.
      if (!confirm(`Remove ${app.name} token from Keychain?\n\nClippy will fall back to the UI path for ${app.name}.`)) return;
      try {
        await window.clippy.clearApiKey?.(app.id);
        settingsApiKeyPresent.set(app.id, false);
        status.classList.remove('set');
        status.textContent = 'Not connected';
        input.placeholder = `Paste your ${app.name} token`;
        flashSaveStatus(`${app.name} disconnected`);
        // Re-render the row so the disconnect link disappears and the
        // placeholder copy updates.
        renderSettingsApiKeys();
      } catch {
        flashSaveStatus(`${app.name} disconnect failed`);
      }
    });
    footer.appendChild(disconnect);
  }

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

function flashSaveStatus(text: string): void {
  const el = document.getElementById('settings-apps-save-status');
  if (!el) return;
  el.textContent = text;
  window.setTimeout(() => {
    if (el.textContent === text) el.textContent = '';
  }, 2500);
}

// Lazy-load: only build the picker when the user opens the Apps tab.
// Avoids hitting the keychain (and the IPC roundtrip) on every Settings
// open for users who never touch this panel.
document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((item) => {
  if (item.dataset.section !== 'apps') return;
  item.addEventListener('click', () => { void loadAppsTab(); });
});

// ═══════════════════════════════════════════════════════════════════════
// Settings → General → Permissions card
//
// Shows live grant status for Accessibility, Screen Recording, and
// Automation. Reveals an "Open" button for each permission that is not
// yet granted so the user can jump straight to the relevant System
// Settings pane without re-running onboarding.
//
// Refresh strategy: call loadPermissions() on page load AND every time
// the user clicks the General tab, so status reflects grants made while
// the settings window is open.
// ═══════════════════════════════════════════════════════════════════════

async function loadPermissions(): Promise<void> {
  const p = await window.clippy.getPermissions?.();
  const set = (statId: string, openId: string, ok: boolean) => {
    const s = document.getElementById(statId);
    const b = document.getElementById(openId) as HTMLButtonElement | null;
    if (s) {
      s.textContent = ok ? 'Granted ✓' : 'Not granted';
      s.style.color = ok ? '#16a34a' : 'var(--s-danger,#dc2626)';
    }
    if (b) b.style.display = ok ? 'none' : '';
  };
  set('perm-stat-acc', 'perm-open-acc', p?.accessibility === 'granted');
  set('perm-stat-sr', 'perm-open-sr', p?.screenRecording === 'granted');
  set('perm-stat-auto', 'perm-open-auto', Object.values(p?.automation ?? {}).some((v) => v === 'granted'));
}

document.getElementById('perm-open-acc')?.addEventListener('click', async () => {
  await window.clippy.openPermissionPane?.('accessibility');
});
document.getElementById('perm-open-sr')?.addEventListener('click', async () => {
  await window.clippy.openPermissionPane?.('screenRecording');
});
document.getElementById('perm-open-auto')?.addEventListener('click', async () => {
  await window.clippy.openPermissionPane?.('automation');
});

// Load on initial render.
void loadPermissions();

// Re-load every time the General tab is shown so status reflects any
// grants the user may have made while Settings was open.
document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((item) => {
  if (item.dataset.section !== 'general') return;
  item.addEventListener('click', () => { void loadPermissions(); });
});
