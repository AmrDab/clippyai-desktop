/**
 * Single source of truth for the renderer-facing API surface exposed by
 * `src/preload/index.ts` via contextBridge.exposeInMainWorld('clippy', ...).
 *
 * Why this file exists:
 *   v0.12.0 had three separate `declare global { interface Window }` blocks
 *   in onboarding.ts, settings.ts, and main.ts — each declaring a partial
 *   subset of Window.clippy. They drifted from the actual preload, missing
 *   handlers (testClawdCursor, openSubscriptionPortal, etc.) showed as TS
 *   errors. tsc --noEmit emitted 17 errors that vite silently transpiled
 *   past, so they shipped to users.
 *
 * Format: ambient declaration file — NO `import`/`export` statements at the
 * top level. That keeps it in the global scope so `interface Window` merges
 * into the built-in Window and `declare module '*.mjs'` applies project-wide.
 * If you ever add an import here, both effects break silently.
 *
 * Rules:
 *   - This file is the ONLY place Window.clippy is augmented.
 *   - It must mirror src/preload/index.ts exactly. Adding/removing a method
 *     in the preload is a two-file edit (preload + this).
 */

interface Window {
  clippy: {
    // ── Conversation
    sendMessage: (text: string) => Promise<string>;

    // ── Diagnostics
    testClawdCursor: () => Promise<boolean>;

    // ── License management
    validateLicense: (key: string) => Promise<{ valid: boolean; plan: string }>;
    saveLicense: (key: string, plan: string, buddyName: string, ttsVoice: string) => Promise<boolean>;
    clearLicense: () => Promise<boolean>;
    openExternalUrl: (url: string) => Promise<boolean>;
    openOnboarding: () => void;
    onOnboardingComplete: () => Promise<void>;

    // ── Settings
    getConfig: () => Promise<Record<string, unknown>>;
    updateSettings: (settings: Record<string, unknown>) => Promise<boolean>;

    // ── Speech / TTS
    onSpeak: (cb: (payload: { text: string; animate: string }) => void) => void;
    onTtsToggle: (cb: (enabled: boolean) => void) => void;
    onSpeechRate: (cb: (rate: number) => void) => void;

    // ── Mode
    onModeChange: (cb: (mode: 'awake' | 'sleep') => void) => void;
    onProactiveToggle: (cb: (enabled: boolean) => void) => void;
    /** v0.12.3 — bubble auto-hide ms; 0 = manual */
    onBubbleAutoHide: (cb: (ms: number) => void) => void;
    /** v0.12.5 — manual proactive trigger from Settings UI */
    fireProactiveTip?: () => Promise<{ ok: boolean; reason?: string }>;

    // ── Window control
    setClickThrough: (enabled: boolean) => void;
    openSettings: () => void;
    showContextMenu: () => void;
    moveWindow: (deltaX: number, deltaY: number) => void;
    expandWindow: () => void;
    collapseWindow: () => void;
    closeWindow: () => void;

    // ── Animation playback
    onPlayAnimation: (cb: (name: string) => void) => void;

    // ── Auto-update
    checkForUpdates: () => Promise<boolean>;
    downloadUpdate: () => Promise<boolean>;
    installUpdate: () => Promise<boolean>;
    openManualUpdate: () => Promise<boolean>;
    onUpdateAvailable: (cb: (version: string) => void) => void;
    onUpdateNotAvailable: (cb: () => void) => void;
    onUpdateReady: (cb: (version: string) => void) => void;
    onUpdateFailed: (cb: (payload: { version: string; reason: string; manualUrl: string }) => void) => void;

    // ── User profile
    getUserProfile: () => Promise<Record<string, string>>;
    saveUserProfile: (data: Record<string, string>) => Promise<boolean>;
    isProfileSetUp: () => Promise<boolean>;

    // ── Logs / support
    readLogFile: () => Promise<string>;
    clearLogFile: () => Promise<boolean>;
    reportLogs: (content: string, description?: string) => Promise<{ ok: boolean; reportId?: string }>;

    // ── Launch on startup
    getLaunchOnStartup: () => Promise<boolean>;
    setLaunchOnStartup: (enabled: boolean) => Promise<boolean>;

    // ── Subscription
    openSubscriptionPortal: () => Promise<boolean>;

    // ── Renderer→main log bridge (v0.11.28)
    log?: (
      level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
      component: string,
      message: string,
      data?: unknown,
    ) => void;
  };
}

// Bundled animation assets shipped under assets/agents/clippy/. Loaded via
// dynamic import() at runtime; without these declarations TS reports
// TS7016 "Could not find a declaration file for module '...mjs'".
declare module '*.mjs' {
  const value: unknown;
  export default value;
}
