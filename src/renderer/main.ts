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

  // v0.16.1 — Interaction-frequency mood tracker. Every user-initiated
  // interaction (click on Clippy, sent message, drag) appends a timestamp
  // to interactionLog. Every 60s we prune to a 1hr window and recompute
  // mood: 0 in last 60min = grumpy, 5+ in last 30min = happy, else neutral.
  // The controller's own cascade can override this with drowsy/dozing
  // when truly idle; noteActivity() resets cascade so user actions always
  // win over cascade decay.
  const interactionLog: number[] = [];
  function noteUserInteraction(): void {
    interactionLog.push(Date.now());
    clippyCtrl.noteActivity();
  }
  function recomputeMood(): void {
    const now = Date.now();
    // Prune anything older than 1hr in-place
    while (interactionLog.length > 0 && now - interactionLog[0] > 3_600_000) {
      interactionLog.shift();
    }
    const inLastHour = interactionLog.length;
    const inLast30 = interactionLog.filter((t) => now - t <= 1_800_000).length;
    let next: 'happy' | 'grumpy' | 'neutral';
    if (inLast30 >= 5) next = 'happy';
    else if (inLastHour === 0) next = 'grumpy';
    else next = 'neutral';
    // Only override mood if controller isn't cascade-sleeping. drowsy/dozing
    // take precedence — user has been quiet AND no cursor movement, that's
    // a stronger signal than "0 interactions in the last hour".
    const cur = clippyCtrl.getMood();
    if (cur !== 'drowsy' && cur !== 'dozing') clippyCtrl.setMood(next);
  }
  // Recompute every 60s. Cheap (array filter on at most a few dozen entries).
  setInterval(recomputeMood, 60_000);

  let lastUserText = '';
  const bubbleCtrl = new BubbleController(async (userText) => {
    lastUserText = userText;
    noteUserInteraction(); // v0.16.1 — sent message counts as engagement
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
  // v0.16.1 — also drives the sleep-cascade ticker: any cursor delta > 5px
  // counts as "activity" and resets drowsy/dozing back to neutral.
  let lastLookAt = 0;
  let playTagActive = false;
  let lastCursorMx = -9999;
  let lastCursorMy = -9999;

  function handleCursorPos(pos: { cx: number; cy: number; mx: number; my: number }): void {
    // v0.16.1 — activity detection (runs even when Clippy is mid-action so
    // sleep cascade still resets while a "What can I help you with" bubble
    // is showing). Threshold 5px filters out noise like sub-pixel jitter
    // and tablet-stylus jitter.
    if (lastCursorMx !== -9999) {
      const moveDist = Math.hypot(pos.mx - lastCursorMx, pos.my - lastCursorMy);
      if (moveDist > 5) clippyCtrl.noteActivity();
    }
    lastCursorMx = pos.mx;
    lastCursorMy = pos.my;
    // v0.16.1 — step the sleep cascade each tick. Cheap (just a Date.now()
    // diff + maybe a mood mutation). Happens regardless of working/sleeping
    // because the controller's own guards handle those cases internally.
    clippyCtrl.tickSleepCascade();

    if (playTagActive) return; // tag controller handles cursor below
    // Don't interrupt: skip if Clippy is mid-action or mid-working-loop or sleeping
    if ((clippyCtrl as unknown as { isPlayingAction: boolean }).isPlayingAction) return;
    if ((clippyCtrl as unknown as { isWorking: boolean }).isWorking) return;
    if ((clippyCtrl as unknown as { isSleeping: boolean }).isSleeping) return;
    // v0.16.1 — also skip look-glances when dozing (Clippy is "asleep" via
    // cascade; a passing cursor shouldn't yank him alert without real
    // activity, which already reset mood above).
    if (clippyCtrl.getMood() === 'dozing') return;
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
  // v0.16.1 — Drag inertia. Capture per-mousemove (timestamp, dx, dy) in a
  // small ring buffer; on mouseup compute velocity from the last ~120ms of
  // motion and apply a friction+gravity loop until vx,vy < 0.5. Calls
  // window.clippy.moveWindow with integer deltas just like a live drag.
  // The main process bounds-clamps so we can't fling Clippy offscreen.
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let hasMoved = false;
  // Ring buffer of recent drag samples for velocity calculation.
  type DragSample = { t: number; dx: number; dy: number };
  const dragSamples: DragSample[] = [];
  let inertiaRAF: number | null = null;

  function stopInertia(): void {
    if (inertiaRAF !== null) {
      cancelAnimationFrame(inertiaRAF);
      inertiaRAF = null;
    }
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    stopInertia(); // grabbing during inertia cancels it
    isDragging = true;
    hasMoved = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    dragSamples.length = 0;
    canvas.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.screenX - dragStartX;
    const dy = e.screenY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved = true;
      window.clippy.moveWindow(dx, dy);
      // Record sample for velocity. Keep ring buffer ≤ 8 entries (200-300ms
      // of motion at 60Hz mousemove); older samples get dropped to keep
      // velocity reactive to recent flick direction, not the whole drag.
      dragSamples.push({ t: performance.now(), dx, dy });
      if (dragSamples.length > 8) dragSamples.shift();
      dragStartX = e.screenX;
      dragStartY = e.screenY;
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging && hasMoved) {
      // v0.16.1 — End of a real drag: launch inertia from buffered velocity.
      // Compute average dx/dy per ms over the last ~120ms of samples, then
      // feed that into the RAF-driven flick loop. Friction 0.92 per frame
      // gives a ~500ms decay at 60Hz; that's snappy without feeling broken.
      const now = performance.now();
      const recent = dragSamples.filter((s) => now - s.t < 120);
      if (recent.length >= 2) {
        const span = Math.max(16, recent[recent.length - 1].t - recent[0].t);
        const sumDx = recent.reduce((s, p) => s + p.dx, 0);
        const sumDy = recent.reduce((s, p) => s + p.dy, 0);
        // Velocity in px per 16ms-frame
        let vx = (sumDx / span) * 16;
        let vy = (sumDy / span) * 16;
        // Cap fling speed so a vigorous flick can't teleport Clippy.
        const MAX_V = 40;
        const mag = Math.hypot(vx, vy);
        if (mag > MAX_V) { vx = vx / mag * MAX_V; vy = vy / mag * MAX_V; }
        // Only animate inertia if the user actually flicked, not a slow lift.
        if (mag > 4) {
          const FRICTION = 0.92;
          const GRAVITY = 0.6; // px/frame² — gentle settling, not heavy
          const step = () => {
            vx *= FRICTION;
            vy = vy * FRICTION + GRAVITY;
            window.clippy.moveWindow(Math.round(vx), Math.round(vy));
            if (Math.abs(vx) < 0.5 && Math.abs(vy) < 1.0) {
              inertiaRAF = null;
              return;
            }
            inertiaRAF = requestAnimationFrame(step);
          };
          inertiaRAF = requestAnimationFrame(step);
        }
      }
      dragSamples.length = 0;
      noteUserInteraction(); // dragging counts as engagement
    }
    if (isDragging && !hasMoved) {
      // Single click on Clippy
      console.log('[Main] Clippy clicked!');
      noteUserInteraction(); // v0.16.1 — click counts as engagement

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
