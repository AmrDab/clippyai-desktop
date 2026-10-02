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

  // v0.19.0 PR-6 — set data-platform so the Liquid Glass theme picks up
  // wherever it's referenced. On the main window this is mostly a no-op
  // visually since the bubble has its own treatment, but the first-win
  // overlay (created below at runtime) keys off it. We also set it on
  // documentElement so deeply-nested CSS variables resolve cleanly.
  (function setPlatform(): void {
    const p = (navigator.platform || '').toLowerCase();
    let plat = 'other';
    if (p.includes('mac')) plat = 'mac';
    else if (p.includes('win')) plat = 'win';
    document.body.setAttribute('data-platform', plat);
    document.documentElement.setAttribute('data-platform', plat);
  })();

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
    // v0.20.0 (voice v1) — apply persisted TTS engine (System default /
    // OpenAI premium). If OpenAI fails at speak-time, tts.ts falls back.
    if (config.ttsEngine === 'openai') tts.setEngine('openai');
  } catch {}
  // Live engine switch from Settings → Voice.
  window.clippy.onTtsEngine?.((engine) => tts.setEngine(engine));

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
  // v0.19.0 — track the rule_id of the currently-visible proactive tip so
  // "Don't suggest this again" in the context menu knows which rule to deny.
  let currentRuleId: string | undefined;

  window.clippy.onSpeak(({ text, animate, ruleId }) => {
    const safeText = text || '';
    if (safeText) {
      bubbleCtrl.speak(safeText);
      tts.speak(safeText);
    }
    if (animate) clippyCtrl.playNamed(animate);
    // Track rule source for context-menu "Don't suggest this again".
    currentRuleId = ruleId;
  });

  // feat/pricing-free-tier — capped free user hit the monthly token cap. Show
  // the worker's warm Clippy line WITH an Upgrade button that opens the Power
  // checkout. Speak it too so it reads naturally; the button is the affordance.
  const STRIPE_POWER_URL = 'https://buy.stripe.com/8x2bJ06jXfC65XDe2Oe3e03'; // $19.99/mo
  const STRIPE_MAX_URL   = 'https://buy.stripe.com/5kQaEW7o1cpUdq52k6e3e05'; // $39.99/mo
  void STRIPE_MAX_URL; // reserved — Max upgrade prompt will use this in a future turn
  window.clippy.onUpgrade?.(({ text }) => {
    const safeText = text || "I'm tapped out on free tokens this month.";
    bubbleCtrl.speakWithActions(safeText, [
      { label: 'Upgrade', variant: 'primary', onClick: () => { void window.clippy.openExternalUrl(STRIPE_POWER_URL); } },
      // No-op onClick so "Maybe later" dismisses without sending stray text.
      { label: 'Maybe later', variant: 'ghost', onClick: () => { bubbleCtrl.hide(); } },
    ]);
    tts.speak(safeText);
    clippyCtrl.playNamed('Alert');
  });

  // Phase 3 guardrails — "Can I …?" before a gated tool runs. Approve/Deny
  // answer by id; replacing or hiding the bubble while pending counts as
  // Deny. TTS says only the generic line — never the args.
  window.clippy.onApprovalRequest?.(({ id, summary }) => {
    let answered = false;
    const answer = (approved: boolean) => {
      if (answered) return;
      answered = true;
      void window.clippy.respondApproval(id, approved);
    };
    bubbleCtrl.speakWithActions(`Can I **${summary}**?`, [
      { label: 'Approve', variant: 'primary', onClick: () => { answer(true); bubbleCtrl.showThinking(); } },
      { label: 'Deny', variant: 'ghost', onClick: () => { answer(false); bubbleCtrl.hide(); } },
    ], { sticky: true, onDismiss: () => answer(false) });
    tts.speak('Can I go ahead?');
    clippyCtrl.playNamed('GetAttention');
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
  window.clippy.onSpeechVoice?.((v) => tts.setPreferredVoice(v));
  // v0.12.3 — apply persisted bubble auto-hide on startup + on change.
  // v0.19.0 PR-2 — also apply bubbleDefaultState + bubblePinned. Same
  // config call, so we fold both into the existing try/catch.
  try {
    const cfg = await window.clippy.getConfig();
    const ms = Number(cfg.bubbleAutoHideMs);
    if (Number.isFinite(ms) && ms >= 0) bubbleCtrl.setAutoHideMs(ms);
    const defState = cfg.bubbleDefaultState;
    if (defState === 'compact' || defState === 'standard') {
      bubbleCtrl.setDefaultState(defState);
    }
    if (cfg.bubblePinned === true) bubbleCtrl.setPinned(true);
  } catch { /* config not available; keep defaults */ }
  window.clippy.onBubbleAutoHide?.((ms) => bubbleCtrl.setAutoHideMs(ms));
  window.clippy.onBubbleDefaultState?.((s) => bubbleCtrl.setDefaultState(s));
  window.clippy.onBubblePinned?.((p) => bubbleCtrl.setPinned(p));
  // v0.20.0-alpha.14 — main flips the bubble side (above/below Clippy) when
  // he's near a screen edge; renderer toggles the tail to keep it pointing
  // at him.
  window.clippy.onBubbleSide?.((side) => bubbleCtrl.setSide(side));

  window.clippy.onPlayAnimation((name) => clippyCtrl.playNamed(name));

  // v0.16.0 — task-in-progress animation loop. Replaces the prior one-shot
  // 'Thinking' that froze Clippy during long tasks. Brain emits at handleUser
  // Message entry and finally{}.
  window.clippy.onWorkingStart?.(() => clippyCtrl.startWorkingLoop());
  window.clippy.onWorkingStop?.(() => clippyCtrl.stopWorkingLoop());

  // Step ticker: update bubble text with a brief label while each tool runs
  // so the user sees "Clicking…" / "Reading screen…" instead of static "…".
  window.clippy.onTaskStep?.(({ label }) => bubbleCtrl.showStep(label));

  // v0.17.0 — voice input wiring. Bubble owns the Recorder; main wires
  // the sprite animation hook (so Hearing_1 plays while we record) and
  // the global push-to-talk hotkey IPC (main → renderer voice-start/stop).
  bubbleCtrl.setAnimCallback((name) => clippyCtrl.playNamed(name));
  // Apply persisted voice-enabled config
  try {
    const cfgV = await window.clippy.getConfig();
    if (cfgV.voiceEnabled === false) bubbleCtrl.setVoiceEnabled(false);
  } catch { /* defaults — voice enabled */ }
  window.clippy.onVoiceToggle?.((enabled) => bubbleCtrl.setVoiceEnabled(enabled));
  window.clippy.onVoiceStart?.(() => { void bubbleCtrl.startVoice(); });
  window.clippy.onVoiceStop?.(() => { void bubbleCtrl.stopVoice(); });

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
    // v0.16.2 — bumped from 8s to 25s. Was too eager: Clippy glanced every
    // 8s any time the cursor was > 80px away, which on a 1440p monitor is
    // ALWAYS. Combined with idle cycle + working loop this made Clippy
    // feel jittery. 25s + the cursor-pos pump only firing on actual cursor
    // delta means a stationary user gets a calm Clippy.
    if (Date.now() - lastLookAt < 25000) return;
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

  // === v0.19.0 PR-6 — first-5-wins overlay (post-onboarding) ==========
  // Main process emits 'first-win-overlay' 3s after the user reaches
  // onboarding step 6 ("you're ready"). We surface a non-modal pop-up
  // above Clippy's bubble with the same 5 chips as step 6. Click any
  // chip and the overlay fires the prompt as a normal user message via
  // 'first-win-chip', then closes itself.
  //
  // The chip list is the same FIRST_WINS catalog the onboarding window
  // renders, imported lazily to avoid pulling the whole catalog module
  // unless we actually need it.
  let firstWinOverlayEl: HTMLElement | null = null;
  async function showFirstWinOverlay(): Promise<void> {
    if (firstWinOverlayEl) return; // already showing — re-trigger is no-op
    const { FIRST_WINS } = await import('./app-catalog');
    firstWinOverlayEl = document.createElement('div');
    firstWinOverlayEl.id = 'first-win-overlay';
    const header = document.createElement('div');
    header.id = 'first-win-overlay-header';
    const headerLabel = document.createElement('span');
    headerLabel.textContent = 'Want to try one of these?';
    header.appendChild(headerLabel);
    const closeBtn = document.createElement('button');
    closeBtn.id = 'first-win-overlay-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.addEventListener('click', dismissFirstWinOverlay);
    header.appendChild(closeBtn);
    firstWinOverlayEl.appendChild(header);
    for (const chip of FIRST_WINS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'first-win-chip';
      btn.textContent = chip.label;
      btn.addEventListener('click', async () => {
        // Disable the whole row so a fast-double-click doesn't fire two
        // first-turn messages. The overlay tears down immediately on a
        // successful pump.
        firstWinOverlayEl!.querySelectorAll('button').forEach((b) => (b as HTMLButtonElement).disabled = true);
        try {
          await window.clippy.fireFirstWinChip?.(chip.prompt);
        } catch { /* main logs */ }
        dismissFirstWinOverlay();
      });
      firstWinOverlayEl.appendChild(btn);
    }
    document.body.appendChild(firstWinOverlayEl);
    clippyCtrl.playNamed('GetAttention');
    bubbleCtrl.speak('Want to try one of these?');
  }
  function dismissFirstWinOverlay(): void {
    if (!firstWinOverlayEl) return;
    firstWinOverlayEl.remove();
    firstWinOverlayEl = null;
  }
  window.clippy.onFirstWinOverlay?.(() => { void showFirstWinOverlay(); });

  // When a chip fires (from either the onboarding step-6 OR the overlay
  // here), main.ts pumps that string back to the renderer via
  // 'first-win-chip'. We route it through the same path as a typed
  // message — bubble speak, animate, fire IPC sendMessage. This way the
  // brain treats it as the user's first ask, contextual suggestions can
  // tune off it, and chat history is populated correctly.
  window.clippy.onFirstWinChip?.((text) => {
    if (!text) return;
    dismissFirstWinOverlay();
    bubbleCtrl.speak(text);
    clippyCtrl.think();
    void (async () => {
      try { await window.clippy.sendMessage(text); }
      catch { bubbleCtrl.speakError("Sorry, I couldn't connect right now."); clippyCtrl.alert(); }
    })();
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
  // attempts for the same version (e.g. Gatekeeper blocking the installer),
  // we stop retrying and send the user to the download page on R2
  // (download.clippyai.app, never GitHub) to install manually. Breaks the
  // update loop.
  window.clippy.onUpdateFailed(({ version }) => {
    // v0.19.0 PR-2.2 — guard against empty/unknown version. Main is
    // supposed to suppress the bubble entirely in that case (see
    // updater.ts on('error') handler), but defense-in-depth: never
    // ship the phrase "vunknown" in a user-facing speech bubble.
    if (!version || version === 'unknown' || version === '0.0.0') return;
    pendingUpdate = 'manual';
    pendingUpdateVersion = version;
    clippyCtrl.playNamed('GetAttention');
    bubbleCtrl.speak(`Auto-update to v${version} isn't working on this machine. Click me to open the download page. 📎`);
  });

  // === Drag + Click handling ===
  // v0.16.1 — Drag inertia. Capture per-mousemove (timestamp, dx, dy) in a
  // small ring buffer; on mouseup compute velocity from the last ~120ms of
  // motion and apply a friction-only decay loop until vx,vy < 0.5. Calls
  // window.clippy.moveWindow with integer deltas just like a live drag.
  // The main process bounds-clamps so we can't fling Clippy offscreen.
  // v0.16.2 — removed gravity from the loop (was causing infinite fall).
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
          // BUG FIX from v0.16.1: previously we added GRAVITY=0.6 per frame to
          // vy. With FRICTION=0.92, gravity's terminal velocity is
          // 0.6/(1-0.92) = 7.5 px/frame — well above the 1.0 termination
          // threshold. Result: ANY drag triggered an infinite vy=7.5 fall
          // until the main-process window-bounds clamp parked Clippy at the
          // bottom of the screen. Per support report e8f2fb63 — "when clippy
          // is moved, he falls to the bottom of the desktop".
          //
          // Friction-only inertia: a flick decays naturally, Clippy stays
          // where you put him. Desktop pets don't need gravity — the window
          // is alwaysOnTop, no floor metaphor applies.
          const FRICTION = 0.92;
          const step = () => {
            vx *= FRICTION;
            vy *= FRICTION;
            window.clippy.moveWindow(Math.round(vx), Math.round(vy));
            if (Math.abs(vx) < 0.5 && Math.abs(vy) < 0.5) {
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

      // Barge-in (report 2026-06-15: "clippy kept talking… when a user clicks
      // on him he should stop talking and engage"). A click ALWAYS interrupts
      // whatever Clippy is currently saying, on either TTS engine.
      const wasSpeaking = tts.isSpeaking();
      tts.stop();

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
        // Auto-update gave up — open the R2 download page (download.clippyai.app) in the browser.
        pendingUpdate = null;
        bubbleCtrl.speak(`Opening the download page for v${pendingUpdateVersion}...`);
        window.clippy.openManualUpdate();
      } else if (wasSpeaking) {
        // Interrupted mid-speech: yield to the user. Keep the reply text
        // visible and just open the input — don't talk over them with a
        // canned prompt.
        bubbleCtrl.engageForReply();
        clippyCtrl.wave();
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
    // v0.19.0 — pass the current rule_id (if any) so the context menu can
    // show "Don't suggest this again" for rule-fired tips.
    window.clippy.showContextMenu(currentRuleId);
  });

  console.log('[Main] ClippyAI renderer initialized successfully');
}

init();
