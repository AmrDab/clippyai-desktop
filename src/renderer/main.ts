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
  } catch {}

  const bubbleCtrl = new BubbleController(async (userText) => {
    clippyCtrl.think();
    try {
      const response = await window.clippy.sendMessage(userText);
      bubbleCtrl.speak(response);
      tts.speak(response);
      clippyCtrl.suggest();
    } catch {
      bubbleCtrl.speak("Sorry, I couldn't connect right now.");
      clippyCtrl.idle();
    }
  });

  // === IPC Event Listeners ===
  window.clippy.onSpeak(({ text, animate }) => {
    // Never display undefined/null/empty in the bubble
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
      clippyCtrl.sleep(); // GoodBye transition → snooze idle cycle
      tts.setEnabled(false);
    } else {
      tts.setEnabled(true);
      clippyCtrl.wake(); // Show/Greeting transition → awake idle cycle
      bubbleCtrl.speak("I'm awake and ready to help!");
      tts.speak("I'm awake and ready to help!");
    }
  });

  window.clippy.onTtsToggle((enabled) => tts.setEnabled(enabled));

  window.clippy.onPlayAnimation((name) => clippyCtrl.playNamed(name));

  // === Auto-update (optional, user-driven) ===
  window.clippy.onUpdateAvailable((version) => {
    clippyCtrl.playNamed('Suggest');
    bubbleCtrl.speak(`v${version} is available! Click me to download it. 📎`);

    // Click Clippy → start download
    setTimeout(() => canvas.addEventListener('click', function downloadHandler() {
      canvas.removeEventListener('click', downloadHandler);
      bubbleCtrl.speak('Downloading update...');
      clippyCtrl.playNamed('Searching');
      window.clippy.downloadUpdate();
    }, { once: true }), 2000);
  });

  window.clippy.onUpdateReady((version) => {
    clippyCtrl.playNamed('GetAttention');
    bubbleCtrl.speak(`v${version} is ready! Click me to restart and update. 📎`);
    tts.speak('Update ready!');

    setTimeout(() => canvas.addEventListener('click', function installHandler() {
      canvas.removeEventListener('click', installHandler);
      window.clippy.installUpdate();
    }, { once: true }), 2000);
  });

  // === Drag + Click handling ===
  // Distinguish between drag (move window) and click (open bubble)
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
      // Was a click, not a drag
      console.log('[Main] Clippy clicked!');
      bubbleCtrl.speak('What can I help you with?');
      clippyCtrl.wave();
    }
    isDragging = false;
    canvas.style.cursor = 'pointer';
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.clippy.showContextMenu();
  });

  // No click-through needed — window is sized to Clippy only

  console.log('[Main] ClippyAI renderer initialized successfully');
}

init();
