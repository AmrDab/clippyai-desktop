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

    // ── Guardrails (v0.17.8)
    guardrails: {
      getPolicy: () => Promise<{ mode: 'cautious' | 'standard' | 'trusted'; classOverrides: Record<string, 'allow' | 'approve' | 'block'> }>;
      setPolicy: (next: { mode?: 'cautious' | 'standard' | 'trusted'; classOverrides?: Record<string, 'allow' | 'approve' | 'block'> }) =>
        Promise<{ mode: 'cautious' | 'standard' | 'trusted'; classOverrides: Record<string, 'allow' | 'approve' | 'block'> }>;
      getHistory: () => Promise<Array<{
        id: string; ts: string; tool: string; tier: number;
        actionClass: string | null; argsSummary: string;
        outcome: 'success' | 'failure' | 'unverified' | 'approval_denied' | 'blocked';
        detail: string; taskId?: string;
      }>>;
      clearHistory: () => Promise<boolean>;
    };

    // ── Speech / TTS
    onSpeak: (cb: (payload: { text: string; animate: string }) => void) => void;

    // ── Narration crumbs — short bubble updates fired on every Tool.call
    onClippyCrumb: (cb: (payload: { text: string; tool: string; step: number }) => void) => void;
    onTtsToggle: (cb: (enabled: boolean) => void) => void;
    onSpeechRate: (cb: (rate: number) => void) => void;
    /** v0.16.0 — pitch + volume live updates */
    onSpeechPitch?: (cb: (pitch: number) => void) => void;
    onSpeechVolume?: (cb: (volume: number) => void) => void;

    // ── Mode
    onModeChange: (cb: (mode: 'awake' | 'sleep') => void) => void;
    onProactiveToggle: (cb: (enabled: boolean) => void) => void;
    /** v0.12.3 — bubble auto-hide ms; 0 = manual */
    onBubbleAutoHide: (cb: (ms: number) => void) => void;
    /** v0.12.5 — manual proactive trigger from Settings UI */
    fireProactiveTip?: () => Promise<{ ok: boolean; reason?: string }>;

    // v0.14.1 — Skills tab
    skillsList?: () => Promise<Array<{
      slug: string;
      name: string;
      description: string;
      version: string;
      installedAt: string;
      toolName: string;
      installPath: string;
      capability_tags: string[];
    }>>;
    skillsSearch?: (query: string) => Promise<Array<{
      slug: string;
      name: string;
      summary: string;
      version: string;
      score: number;
      safety: 'safe' | 'consent' | 'reject';
      capability_tags: string[];
    }>>;
    skillsInstall?: (slug: string, version?: string) => Promise<{ ok: boolean; slug?: string; name?: string; version?: string; error?: string }>;
    skillsUninstall?: (slug: string) => Promise<{ ok: boolean; error?: string }>;
    /** v0.14.1 — Brain → Mail Setup status panel */
    mailEnvStatus?: () => Promise<{
      classic_outlook_com: boolean;
      new_outlook_installed: boolean;
      default_mailto_handler: string | null;
      default_is_olk: boolean;
      probed_at: string;
    } | null>;
    /** v0.14.1 — About → active AI model string (kimi-k2.5 / kimi-k2.6 / ...) */
    activeModel?: () => Promise<string | null>;
    /** v0.16.0 — task-in-progress animation loop signals */
    onWorkingStart?: (cb: () => void) => void;
    onWorkingStop?: (cb: () => void) => void;
    /** v0.17.0 — Voice input (offline whisper.cpp transcription) */
    transcribeAudio?: (wav: Uint8Array, initialPrompt?: string) => Promise<{ ok: boolean; text?: string; error?: string; elapsedMs?: number }>;
    sttStatus?: () => Promise<{ ready: boolean; reason?: string }>;
    /** voice parity — optional OpenAI TTS proxy. Returns audio bytes on ok;
     *  `unavailable` means no key configured (renderer uses local
     *  SpeechSynthesis). The key never crosses this bridge. */
    synthesizeSpeech?: (text: string, voice?: string) => Promise<{
      ok: boolean;
      audio?: Uint8Array;
      mimeType?: string;
      error?: string;
      unavailable?: boolean;
    }>;
    /** Write-only: stores the OpenAI key in the OS secret store. No getter exists. */
    setOpenAiKey?: (token: string) => Promise<{ ok: boolean; error?: string }>;
    clearOpenAiKey?: () => Promise<{ ok: boolean; error?: string }>;
    onTtsEngine?: (cb: (engine: 'system' | 'openai') => void) => void;
    onVoiceStart?: (cb: () => void) => void;
    onVoiceStop?: (cb: () => void) => void;
    onVoiceToggle?: (cb: (enabled: boolean) => void) => void;
    /** v0.16.0 — cursor position pump for liveliness (cursor-look + play-tag) */
    onCursorPos?: (cb: (pos: { cx: number; cy: number; mx: number; my: number }) => void) => void;
    /** v0.16.0 — play-tag mode toggle */
    onPlayTagStart?: (cb: () => void) => void;
    onPlayTagStop?: (cb: () => void) => void;
    /** v0.15.0 — Settings → Web → mcp-chrome extension status */
    mcpChromeStatus?: () => Promise<{
      ready: boolean;
      url: string;
      detected_at: string | null;
      tool_count: number;
      tools: string[];
      error?: string;
    } | null>;
    mcpChromeRefresh?: () => Promise<{
      ready: boolean;
      url: string;
      detected_at: string | null;
      tool_count: number;
      tools: string[];
      error?: string;
    } | null>;

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
