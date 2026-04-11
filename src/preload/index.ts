import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clippy', {
  sendMessage: (text: string) => ipcRenderer.invoke('user-message', text),

  // executeTool removed from preload — only brain.ts (main process) should call it directly
  testClawdCursor: () => ipcRenderer.invoke('test-clawdcursor'),

  validateLicense: (key: string) => ipcRenderer.invoke('validate-license', key),

  saveLicense: (key: string, plan: string, buddyName: string, ttsVoice: string) =>
    ipcRenderer.invoke('save-license', key, plan, buddyName, ttsVoice),

  getConfig: () => ipcRenderer.invoke('get-config'),

  updateSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke('update-settings', settings),

  onSpeak: (cb: (payload: { text: string; animate: string }) => void) => {
    ipcRenderer.on('clippy-speak', (_e, payload) => cb(payload));
  },

  onModeChange: (cb: (mode: 'awake' | 'sleep') => void) => {
    ipcRenderer.on('mode-change', (_e, mode) => cb(mode));
  },

  onTtsToggle: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('tts-toggle', (_e, enabled) => cb(enabled));
  },

  onProactiveToggle: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('proactive-toggle', (_e, enabled) => cb(enabled));
  },

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

  moveWindow: (deltaX: number, deltaY: number) => {
    ipcRenderer.send('move-window', deltaX, deltaY);
  },

  expandWindow: () => {
    ipcRenderer.send('expand-window');
  },

  collapseWindow: () => {
    ipcRenderer.send('collapse-window');
  },

  closeWindow: () => {
    ipcRenderer.send('close-onboarding');
  },

  // License management
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),
  clearLicense: () => ipcRenderer.invoke('clear-license'),
  openOnboarding: () => ipcRenderer.send('open-onboarding'),
  onOnboardingComplete: () => ipcRenderer.send('onboarding-complete'),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateAvailable: (cb: (version: string) => void) => {
    ipcRenderer.on('update-available', (_e, version) => cb(version));
  },
  onUpdateReady: (cb: (version: string) => void) => {
    ipcRenderer.on('update-ready', (_e, version) => cb(version));
  },

  // User profile
  getUserProfile: () => ipcRenderer.invoke('get-user-profile'),
  saveUserProfile: (data: Record<string, string>) => ipcRenderer.invoke('save-user-profile', data),
  isProfileSetUp: () => ipcRenderer.invoke('is-profile-set-up'),

  // Log viewer
  readLogFile: () => ipcRenderer.invoke('read-log-file'),
  clearLogFile: () => ipcRenderer.invoke('clear-log-file'),
  reportLogs: (content: string) => ipcRenderer.invoke('report-logs', content),
});
