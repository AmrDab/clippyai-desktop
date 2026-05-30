import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clippy', {
  sendMessage: (text: string) => ipcRenderer.invoke('user-message', text),

  // executeTool removed from preload — only brain.ts (main process) should call it directly
  testClawdCursor: () => ipcRenderer.invoke('test-clawdcursor'),

  validateLicense: (key: string) => ipcRenderer.invoke('validate-license', key),

  saveLicense: (key: string, plan: string, buddyName: string, ttsVoice: string) =>
    ipcRenderer.invoke('save-license', key, plan, buddyName, ttsVoice),

  getConfig: () => ipcRenderer.invoke('get-config'),

  // ── v0.17.8 — Guardrails (permission policy + action history)
  guardrails: {
    getPolicy: () => ipcRenderer.invoke('guardrails:get-policy'),
    setPolicy: (next: { mode?: string; classOverrides?: Record<string, string> }) =>
      ipcRenderer.invoke('guardrails:set-policy', next),
    getHistory: () => ipcRenderer.invoke('guardrails:get-history'),
    clearHistory: () => ipcRenderer.invoke('guardrails:clear-history'),
  },

  updateSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke('update-settings', settings),

  onSpeak: (cb: (payload: { text: string; animate: string }) => void) => {
    ipcRenderer.on('clippy-speak', (_e, payload) => cb(payload));
  },

  // v0.17.8 — short, present-progressive crumbs that update the bubble while
  // a tool is running ("Reading your inbox", "Sending email"). Emitted by
  // brain.ts on every Tool.call. Source of truth for the crumb string is
  // tool-meta.ts:narration → narrationFor().
  onClippyCrumb: (cb: (payload: { text: string; tool: string; step: number }) => void) => {
    ipcRenderer.on('clippy-crumb', (_e, payload) => cb(payload));
  },

  onModeChange: (cb: (mode: 'awake' | 'sleep') => void) => {
    ipcRenderer.on('mode-change', (_e, mode) => cb(mode));
  },

  onTtsToggle: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('tts-toggle', (_e, enabled) => cb(enabled));
  },

  onSpeechRate: (cb: (rate: number) => void) => {
    ipcRenderer.on('speech-rate', (_e, rate) => cb(rate));
  },
  // v0.16.0 — pitch + volume live updates
  onSpeechPitch: (cb: (pitch: number) => void) => {
    ipcRenderer.on('speech-pitch', (_e, pitch) => cb(pitch));
  },
  onSpeechVolume: (cb: (volume: number) => void) => {
    ipcRenderer.on('speech-volume', (_e, volume) => cb(volume));
  },

  onProactiveToggle: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('proactive-toggle', (_e, enabled) => cb(enabled));
  },

  // v0.12.3 — bubble auto-hide setting changed; bubble.ts updates its
  // internal autoHideMs without a window reload.
  onBubbleAutoHide: (cb: (ms: number) => void) => {
    ipcRenderer.on('bubble-auto-hide', (_e, ms) => cb(ms));
  },

  // v0.12.5 — manual proactive trigger from Settings UI.
  fireProactiveTip: () => ipcRenderer.invoke('fire-proactive-tip'),

  // v0.14.1 — Settings → Skills tab
  skillsList: () => ipcRenderer.invoke('skills-list'),
  skillsSearch: (query: string) => ipcRenderer.invoke('skills-search', query),
  skillsInstall: (slug: string, version?: string) => ipcRenderer.invoke('skills-install', slug, version),
  skillsUninstall: (slug: string) => ipcRenderer.invoke('skills-uninstall', slug),
  // v0.14.1 — Settings → Brain "Mail Setup" status
  mailEnvStatus: () => ipcRenderer.invoke('mail-env-status'),
  // v0.14.1 — Settings → About active-model display
  activeModel: () => ipcRenderer.invoke('active-model'),

  // v0.15.0 — Settings → Web mcp-chrome status + refresh
  mcpChromeStatus: () => ipcRenderer.invoke('mcp-chrome-status'),
  mcpChromeRefresh: () => ipcRenderer.invoke('mcp-chrome-refresh'),

  setClickThrough: (enabled: boolean) => {
    ipcRenderer.send('set-click-through', enabled);
  },

  openSettings: () => {
    ipcRenderer.send('open-settings');
  },

  showContextMenu: () => {
    ipcRenderer.send('show-context-menu');
  },

  onPlayAnimation: (cb: (name: string) => void) => {
    ipcRenderer.on('play-animation', (_e, name) => cb(name));
  },

  // v0.17.0 — Voice input. Renderer encodes WAV in src/renderer/recorder.ts
  // and calls this to transcribe via bundled whisper.cpp in main.
  transcribeAudio: (wav: Uint8Array, initialPrompt?: string) =>
    ipcRenderer.invoke('transcribe-audio', wav, initialPrompt),
  sttStatus: () => ipcRenderer.invoke('stt-status'),

  // voice parity — optional OpenAI TTS. synthesizeSpeech returns audio
  // BYTES (the key stays in main); on unavailable/error the renderer falls
  // back to local SpeechSynthesis. setOpenAiKey is write-only (no getter
  // exists), clearOpenAiKey wipes the secret store + presence + reverts to
  // the free System engine.
  synthesizeSpeech: (text: string, voice?: string) =>
    ipcRenderer.invoke('synthesize-speech', text, voice),
  setOpenAiKey: (token: string) => ipcRenderer.invoke('set-openai-key', token),
  clearOpenAiKey: () => ipcRenderer.invoke('clear-openai-key'),
  // Main pushes the engine choice so tts.ts switches live on settings change.
  onTtsEngine: (cb: (engine: 'system' | 'openai') => void) => {
    ipcRenderer.on('tts-engine', (_e, engine) => cb(engine));
  },

  // v0.17.0 — global push-to-talk hotkey signals from main process
  onVoiceStart: (cb: () => void) => {
    ipcRenderer.on('voice-start', () => cb());
  },
  onVoiceStop: (cb: () => void) => {
    ipcRenderer.on('voice-stop', () => cb());
  },
  // v0.17.0 — voice enable/disable from Settings → push to renderer
  onVoiceToggle: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('voice-toggle', (_e, enabled) => cb(enabled));
  },
  // v0.16.0 — task-in-progress animation loop. Brain emits 'working-start'
  // at handleUserMessage entry and 'working-stop' in its finally{}. Renderer
  // cycles WORKING_ANIMS continuously between them so Clippy never freezes.
  onWorkingStart: (cb: () => void) => {
    ipcRenderer.on('working-start', () => cb());
  },
  onWorkingStop: (cb: () => void) => {
    ipcRenderer.on('working-stop', () => cb());
  },

  // v0.16.0 — periodic cursor position pump (main → renderer). At 1Hz when
  // idle (so Clippy can glance at the cursor), 30Hz during play-tag.
  onCursorPos: (cb: (pos: { cx: number; cy: number; mx: number; my: number }) => void) => {
    ipcRenderer.on('cursor-pos', (_e, pos) => cb(pos));
  },

  // v0.16.0 — play-tag mode toggle.
  onPlayTagStart: (cb: () => void) => {
    ipcRenderer.on('play-tag-start', () => cb());
  },
  onPlayTagStop: (cb: () => void) => {
    ipcRenderer.on('play-tag-stop', () => cb());
  },

  moveWindow: (deltaX: number, deltaY: number) => {
    ipcRenderer.send('move-window', deltaX, deltaY);
  },

  expandWindow: () => {
    ipcRenderer.send('expand-window');
  },

  collapseWindow: () => {
    ipcRenderer.send('collapse-window');
  },

  // Main pushes which side of Clippy the bubble body grows on (anchor-aware,
  // multi-display) so the renderer can flip the tail. 'above' = Clippy below
  // the bubble (default); 'below' = Clippy above it.
  onBubbleSide: (cb: (side: 'above' | 'below') => void) => {
    ipcRenderer.on('bubble-side', (_e, side) => cb(side));
  },

  closeWindow: () => {
    ipcRenderer.send('close-onboarding');
  },

  // License management
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),
  clearLicense: () => ipcRenderer.invoke('clear-license'),
  openOnboarding: () => ipcRenderer.send('open-onboarding'),
  onOnboardingComplete: () => ipcRenderer.invoke('onboarding-complete'),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openManualUpdate: () => ipcRenderer.invoke('open-manual-update'),
  onUpdateAvailable: (cb: (version: string) => void) => {
    ipcRenderer.on('update-available', (_e, version) => cb(version));
  },
  onUpdateNotAvailable: (cb: () => void) => {
    ipcRenderer.on('update-not-available', () => cb());
  },
  onUpdateReady: (cb: (version: string) => void) => {
    ipcRenderer.on('update-ready', (_e, version) => cb(version));
  },
  onUpdateFailed: (cb: (payload: { version: string; reason: string; manualUrl: string }) => void) => {
    ipcRenderer.on('update-failed', (_e, payload) => cb(payload));
  },

  // User profile
  getUserProfile: () => ipcRenderer.invoke('get-user-profile'),
  saveUserProfile: (data: Record<string, string>) => ipcRenderer.invoke('save-user-profile', data),
  isProfileSetUp: () => ipcRenderer.invoke('is-profile-set-up'),

  // Log viewer
  readLogFile: () => ipcRenderer.invoke('read-log-file'),
  clearLogFile: () => ipcRenderer.invoke('clear-log-file'),
  reportLogs: (content: string, description?: string) =>
    ipcRenderer.invoke('report-logs', content, description ?? ''),

  // Launch-on-startup (wired in settings)
  getLaunchOnStartup: () => ipcRenderer.invoke('get-launch-on-startup'),
  setLaunchOnStartup: (enabled: boolean) => ipcRenderer.invoke('set-launch-on-startup', enabled),

  // Stripe customer portal (Manage Subscription link)
  openSubscriptionPortal: () => ipcRenderer.invoke('open-subscription-portal'),

  // v0.11.28 — renderer→main log bridge. Lets bubble/clippy/settings code
  // pipe errors and warnings into the same JSONL file as main, so support
  // reports include UI-side failures (animation load errors, IPC failures
  // before main.handle responds, click-handler exceptions, etc).
  log: (
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    component: string,
    message: string,
    data?: unknown,
  ) => {
    ipcRenderer.send('renderer-log', { level, component, message, data });
  },
});
