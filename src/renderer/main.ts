import { ClippyController, AgentData } from './clippy';
import { BubbleController } from './bubble';
import { TTS } from './tts';

declare global {
  interface Window {
    clippy: {
      sendMessage: (text: string) => Promise<string>;
      validateLicense: (key: string) => Promise<{ valid: boolean; plan: string }>;
      saveLicense: (key: string, plan: string, buddyName: string, ttsVoice: string) => Promise<boolean>;
      getConfig: () => Promise<Record<string, unknown>>;
      updateSettings: (settings: Record<string, unknown>) => Promise<boolean>;
      onSpeak: (cb: (payload: { text: string; animate: string }) => void) => void;
      onModeChange: (cb: (mode: 'awake' | 'sleep') => void) => void;
      onTtsToggle: (cb: (enabled: boolean) => void) => void;
      onProactiveToggle: (cb: (enabled: boolean) => void) => void;
      onSpeechRate: (cb: (rate: number) => void) => void;
      setClickThrough: (enabled: boolean) => void;
      openSettings: () => void;
      showContextMenu: () => void;
      onPlayAnimation: (cb: (name: string) => void) => void;
      moveWindow: (deltaX: number, deltaY: number) => void;
      expandWindow: () => void;
      collapseWindow: () => void;
      closeWindow: () => void;
      downloadUpdate: () => Promise<boolean>;
      installUpdate: () => Promise<boolean>;
      openManualUpdate: () => Promise<boolean>;
      onUpdateAvailable: (cb: (version: string) => void) => void;
      onUpdateReady: (cb: (version: string) => void) => void;
      onUpdateFailed: (cb: (payload: { version: string; reason: string; manualUrl: string }) => void) => void;
      log?: (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', component: string, message: string, data?: unknown) => void;
    };
  }
}

// v0.11.28 — pipe uncaught renderer errors to the main-process JSONL log so
// they show up in support reports. Previously the only visible record was
// DevTools console which the user can't see.
function installRendererLogBridge(component: string): void {
  const send = (level: 'WARN' | 'ERROR', message: string, data?: unknown) => {
    try { window.clippy.log?.(level, component, message, data); } catch { /* bridge unavailable, drop silently */ }
  };
  window.addEventListener('error', (e) => {
    send('ERROR', 'Uncaught error', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error instanceof Error ? e.error.stack?.split('\n').slice(0, 8).join('\n') : undefined,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    send('ERROR', 'Unhandled promise rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack?.split('\n').slice(0, 8).join('\n') : undefined,
    });
  });
}

async function init(): Promise<void> {
  installRendererLogBridge('Renderer.main');
  console.log('[Main] Initializing ClippyAI renderer...');

  let agentData: AgentData;
  let spriteDataUri: string;

  try {
    const [agentModule, mapModule] = await Promise.all([
      import('../../assets/agents/clippy/agent.mjs'),
      import('../../assets/agents/clippy/map.mjs'),
    ]);
    agentData = agentModule.default;
    spriteDataUri = mapModule.default;
    console.log('[Main] Assets loaded. Animations:', Object.keys(agentData.animations).length);
  } catch (err) {
    console.error('[Main] Failed to load assets:', err);
    window.clippy.log?.('ERROR', 'Renderer.main', 'Failed to load assets', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 8).join('\n') : undefined,
    });
    return;
  }

  const canvas = document.getElementById('clippy-canvas') as HTMLCanvasElement;
  const clippyCtrl = new ClippyController(canvas, spriteDataUri, agentData);
  const tts = new TTS();

  try {
    const config = await window.clippy.getConfig();
    if (config.ttsVoice) tts.setPreferredVoice(config.ttsVoice as string);
    if (config.speechRate) tts.setRate(config.speechRate as number);
    if (config.ttsEnabled === false) tts.setEnabled(false);
  } catch {}

  const bubbleCtrl = new BubbleController(async (userText) => {
    clippyCtrl.think();
    try {
      const response = await window.clippy.sendMessage(userText);
      bubbleCtrl.speak(response);
      tts.speak(response);
    } catch {
      bubbleCtrl.speak("Sorry, I couldn't connect right now.");
      clippyCtrl.alert();
    }
  });

  // === IPC Event Listeners ===
  window.clippy.onSpeak(({ text, animate }) => {
    const safeText = text || '';
    if (safeText) {
      bubbleCtrl.speak(safeText);
      tts.speak(safeText);
    }
    if (animate) clippyCtrl.playNamed(animate);
  });

  window.clippy.onModeChange((mode) => {
    if (mode === 'sleep') {
      bubbleCtrl.hide();
      clippyCtrl.sleep();
      tts.setEnabled(false);
    } else {
      tts.setEnabled(true);
      clippyCtrl.wake();
      bubbleCtrl.speak("I'm awake and ready to help!");
      tts.speak("I'm awake and ready to help!");
    }
  });

  window.clippy.onTtsToggle((enabled) => tts.setEnabled(enabled));
  window.clippy.onSpeechRate((rate) => tts.setRate(rate));

  window.clippy.onPlayAnimation((name) => clippyCtrl.playNamed(name));

  // === Auto-update (state-based, NO canvas click hijacking) ===
  // Previous bug: addEventListener('click') on canvas for updates would
  // fire alongside normal click handling → clicking Clippy would quit the
  // app to install an update the user didn't know about. Now we use a flag
  // checked inside the single mouseup handler below.
  let pendingUpdate: 'download' | 'install' | 'manual' | null = null;
  let pendingUpdateVersion = '';

  window.clippy.onUpdateAvailable((version) => {
    pendingUpdate = 'download';
    pendingUpdateVersion = version;
    clippyCtrl.playNamed('GetAttention');
    bubbleCtrl.speak(`v${version} is available! Click me to download it. 📎`);
  });

  window.clippy.onUpdateReady((version) => {
    pendingUpdate = 'install';
    pendingUpdateVersion = version;
    clippyCtrl.playNamed('GetAttention');
    bubbleCtrl.speak(`v${version} is ready! Click me to restart and update. 📎`);
    tts.speak('Update ready!');
  });

  // Auto-update silent-failure fallback: after two failed quitAndInstall
  // attempts for the same version (usually AV/SmartScreen blocking the
  // unsigned installer), we stop retrying and send the user to the GitHub
  // release page to install manually. Breaks the update loop.
  window.clippy.onUpdateFailed(({ version }) => {
    pendingUpdate = 'manual';
    pendingUpdateVersion = version;
    clippyCtrl.playNamed('GetAttention');
    bubbleCtrl.speak(`Auto-update to v${version} isn't working on this machine. Click me to open the download page. 📎`);
  });

  // === Drag + Click handling ===
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let hasMoved = false;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasMoved = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    canvas.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.screenX - dragStartX;
    const dy = e.screenY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved = true;
      window.clippy.moveWindow(dx, dy);
      dragStartX = e.screenX;
      dragStartY = e.screenY;
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging && !hasMoved) {
      // Single click on Clippy
      console.log('[Main] Clippy clicked!');

      if (pendingUpdate === 'download') {
        // User explicitly clicked after seeing "click me to download"
        pendingUpdate = null;
        bubbleCtrl.speak('Downloading update...');
        clippyCtrl.playNamed('Searching');
        window.clippy.downloadUpdate();
      } else if (pendingUpdate === 'install') {
        // User explicitly clicked after seeing "click me to restart"
        pendingUpdate = null;
        bubbleCtrl.speak('Installing update, restarting...');
        window.clippy.installUpdate();
      } else if (pendingUpdate === 'manual') {
        // Auto-update gave up — open GitHub release page in the browser.
        pendingUpdate = null;
        bubbleCtrl.speak(`Opening the download page for v${pendingUpdateVersion}...`);
        window.clippy.openManualUpdate();
      } else {
        // Normal click — open chat bubble
        bubbleCtrl.speak('What can I help you with?');
        clippyCtrl.wave();
      }
    }
    isDragging = false;
    canvas.style.cursor = 'pointer';
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.clippy.showContextMenu();
  });

  console.log('[Main] ClippyAI renderer initialized successfully');
}

init();
