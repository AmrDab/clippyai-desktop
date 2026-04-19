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
      onUpdateAvailable: (cb: (version: string) => void) => void;
      onUpdateReady: (cb: (version: string) => void) => void;
    };
  }
}

async function init(): Promise<void> {
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
  let pendingUpdate: 'download' | 'install' | null = null;
  let pendingUpdateVersion = '';

  window.clippy.onUpdateAvailable((version) => {
    pendingUpdate = 'download';
    pendingUpdateVersion = version;
    clippyCtrl.playNamed('Suggest');
    bubbleCtrl.speak(`v${version} is available! Click me to download it. 📎`);
  });

  window.clippy.onUpdateReady((version) => {
    pendingUpdate = 'install';
    pendingUpdateVersion = version;
    clippyCtrl.playNamed('GetAttention');
    bubbleCtrl.speak(`v${version} is ready! Click me to restart and update. 📎`);
    tts.speak('Update ready!');
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
