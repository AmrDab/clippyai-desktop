import { ClippyController, AgentData } from './clippy';
import { BubbleController } from './bubble';
import { TTS } from './tts';

// Window.clippy types live in src/preload/api.d.ts (single source of truth).

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
    // Wildcard `*.mjs` declarations type the default export as `unknown` to
    // avoid lying about an asset we don't validate. Cast at the boundary.
    agentData = agentModule.default as AgentData;
    spriteDataUri = mapModule.default as string;
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

  let lastUserText = '';
  const bubbleCtrl = new BubbleController(async (userText) => {
    lastUserText = userText;
    clippyCtrl.think();
    try {
      // v0.11.29 — fire-and-forget the IPC. Brain emits 'clippy-speak' for
      // EVERY reply (including the same `response` we'd get here), and the
      // onSpeak listener below renders + speaks it. Calling bubbleCtrl.speak
      // and tts.speak here too caused EVERY message to render TWICE in the
      // bubble + speak TWICE through TTS. Per support report 573d7579.
      await window.clippy.sendMessage(userText);
    } catch {
      // v0.12.5 — visually distinct error reply + retry button.
      bubbleCtrl.speakError("Sorry, I couldn't connect right now.", () => {
        if (lastUserText) void window.clippy.sendMessage(lastUserText);
      });
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

  // v0.16.0 — load pitch + volume on launch + listen for live updates.
  try {
    const cfg2 = await window.clippy.getConfig();
    if (typeof cfg2.speechPitch === 'number') tts.setPitch(cfg2.speechPitch);
    if (typeof cfg2.speechVolume === 'number') tts.setVolume(cfg2.speechVolume);
  } catch { /* defaults applied */ }
  window.clippy.onSpeechPitch?.((p) => tts.setPitch(p));
  window.clippy.onSpeechVolume?.((v) => tts.setVolume(v));
  // v0.12.3 — apply persisted bubble auto-hide on startup + on change.
  try {
    const cfg = await window.clippy.getConfig();
    const ms = Number(cfg.bubbleAutoHideMs);
    if (Number.isFinite(ms) && ms >= 0) bubbleCtrl.setAutoHideMs(ms);
  } catch { /* config not available; keep default */ }
  window.clippy.onBubbleAutoHide?.((ms) => bubbleCtrl.setAutoHideMs(ms));

  window.clippy.onPlayAnimation((name) => clippyCtrl.playNamed(name));

  // v0.16.0 — task-in-progress animation loop. Replaces the prior one-shot
  // 'Thinking' that froze Clippy during long tasks. Brain emits at handleUser
  // Message entry and finally{}.
  window.clippy.onWorkingStart?.(() => clippyCtrl.startWorkingLoop());
  window.clippy.onWorkingStop?.(() => clippyCtrl.stopWorkingLoop());

  // v0.16.0 — cursor-look. Main process pumps cursor position at 1Hz when
  // idle; we periodically (max once per 8s) glance toward the cursor with
  // the appropriate Look* animation. High-lifelikeness, low cost.
  // During play-tag mode, this listener is overridden by the tag controller.
  let lastLookAt = 0;
  let playTagActive = false;

  function handleCursorPos(pos: { cx: number; cy: number; mx: number; my: number }): void {
    if (playTagActive) return; // tag controller handles cursor below
    // Don't interrupt: skip if Clippy is mid-action or mid-working-loop or sleeping
    if ((clippyCtrl as unknown as { isPlayingAction: boolean }).isPlayingAction) return;
    if ((clippyCtrl as unknown as { isWorking: boolean }).isWorking) return;
    if ((clippyCtrl as unknown as { isSleeping: boolean }).isSleeping) return;
    if (Date.now() - lastLookAt < 8000) return; // throttle to once per 8s
    const dx = pos.mx - pos.cx;
    const dy = pos.my - pos.cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 80) return; // cursor on top of Clippy — don't look "at self"
    lastLookAt = Date.now();
    const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angleDeg > -45 && angleDeg <= 45) clippyCtrl.playNamed('LookRight');
    else if (angleDeg > 45 && angleDeg <= 135) clippyCtrl.playNamed('LookDown');
    else if (angleDeg > 135 || angleDeg <= -135) clippyCtrl.playNamed('LookLeft');
    else clippyCtrl.playNamed('LookUp');
  }

  // v0.16.0 — play-tag. Brain detects "wanna play tag" / "let's play tag"
  // / "tag, you're it" in the user's message and emits play-tag-start.
  // Renderer then chases the cursor by calling window.clippy.moveWindow
  // with a flee/seek vector. Caught when overlap < 30px.
  window.clippy.onPlayTagStart?.(() => {
    playTagActive = true;
    clippyCtrl.playNamed('Searching');
    bubbleCtrl.speak("You can't catch me! 📎");
  });
  window.clippy.onPlayTagStop?.(() => {
    playTagActive = false;
  });
  function handleTagCursor(pos: { cx: number; cy: number; mx: number; my: number }): void {
    if (!playTagActive) return;
    const dx = pos.mx - pos.cx;
    const dy = pos.my - pos.cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 35) {
      // Caught!
      playTagActive = false;
      clippyCtrl.playNamed('Congratulate');
      bubbleCtrl.speak(`Tag! You got me! 📎`);
      return;
    }
    // Flee — move opposite to cursor + a touch of jitter so Clippy doesn't
    // run dead-straight (boring) and doesn't get cornered against the edge.
    const speed = 10;
    const nx = -(dx / dist) * speed + (Math.random() - 0.5) * 6;
    const ny = -(dy / dist) * speed + (Math.random() - 0.5) * 6;
    window.clippy.moveWindow(Math.round(nx), Math.round(ny));
  }

  window.clippy.onCursorPos?.((pos) => {
    handleCursorPos(pos);
    handleTagCursor(pos);
  });

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
