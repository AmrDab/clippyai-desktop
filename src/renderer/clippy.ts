export interface AnimationFrame {
  duration: number;
  images: Array<[number, number]>; // [x, y] pixel offsets into sprite sheet
  sound?: string;
  exitBranch?: number;
}

export interface Animation {
  frames: AnimationFrame[];
  useExitBranching?: boolean;
}

export interface AgentData {
  framesize: [number, number];
  overlayCount: number;
  animations: Record<string, Animation>;
  sounds: string[];
}

// v0.16.1 — Mood states drive idle weighting + greeting selection.
//   neutral: normal 1-4 interactions/hr
//   happy:   ≥5 interactions in last 30 min — picks Congratulate / GetArtsy more
//   grumpy:  0 interactions in last hour — sighs (RestPose) + head-scratch more
//   drowsy:  no cursor delta for 90s — biased toward yawny anims (EyeBrowRaise, RestPose)
//   dozing:  no cursor delta for 240s — locked to IdleSnooze loop until woken
export type Mood = 'neutral' | 'happy' | 'grumpy' | 'drowsy' | 'dozing';

// Per-animation base weights for the idle picker. Higher = more often.
// All animations listed must actually exist in agent.mjs (verified for Clippy
// sprite sheet — see assets/agents/clippy/agent.mjs).
const IDLE_BASE_WEIGHTS: Record<string, number> = {
  Idle1_1: 6,
  IdleRopePile: 3,
  IdleAtom: 3,
  IdleSideToSide: 3,
  IdleHeadScratch: 3,
  IdleFingerTap: 3,
  IdleEyeBrowRaise: 3,
  RestPose: 2,
};

// Mood multipliers applied on top of base weights. Default 1.0 if absent.
const MOOD_MULT: Record<Mood, Record<string, number>> = {
  neutral: {},
  happy: {
    Idle1_1: 1.5,
    IdleSideToSide: 1.6,
    IdleAtom: 1.4,
    IdleFingerTap: 1.4,
    RestPose: 0.3,
    IdleHeadScratch: 0.6,
  },
  grumpy: {
    RestPose: 3.5,
    IdleHeadScratch: 2.5,
    IdleEyeBrowRaise: 2.0,
    IdleSideToSide: 0.4,
    IdleAtom: 0.4,
    Idle1_1: 0.6,
  },
  drowsy: {
    RestPose: 4.0,
    IdleEyeBrowRaise: 3.0,
    IdleRopePile: 1.5, // settled / static
    IdleSideToSide: 0.2,
    IdleAtom: 0.2,
    IdleFingerTap: 0.2,
  },
  dozing: {
    // dozing is handled separately (forces IdleSnooze) — weights unused
  },
};

// Hour-of-day modifiers. Night ramps RestPose/EyeBrowRaise up, morning ramps
// active anims up. Awake hours (10-21) get neutral 1.0 across the board.
function circadianMult(hour: number): Record<string, number> {
  if (hour >= 22 || hour < 5) {
    // Late night
    return { RestPose: 2.5, IdleEyeBrowRaise: 1.8, IdleAtom: 0.4, IdleSideToSide: 0.4 };
  }
  if (hour >= 5 && hour < 9) {
    // Early morning — wake-up energy
    return { IdleSideToSide: 1.6, IdleAtom: 1.5, IdleFingerTap: 1.4, RestPose: 0.5 };
  }
  return {};
}

const SLEEP_IDLES = ['IdleSnooze', 'RestPose'];
// v0.16.2 — bumped up from 8-15s to 18-30s per user feedback ("clippy
// over doing the animations"). Previous timing produced a near-constant
// fidget — every 8s Clippy did SOMETHING, plus working-loop, plus cursor-
// look, plus brain-emitted per-reply animations — too much movement on
// the periphery of vision. 18-30s feels closer to a real desk pet.
const IDLE_CYCLE_MIN = 18000;
const IDLE_CYCLE_MAX = 30000;

// v0.16.1 — Sleep cascade thresholds. Triggered by cursor-pos pump silence —
// renderer sees no meaningful cursor delta for N ms and steps Clippy down.
// Resets on any user message or cursor delta > 5px.
const DROWSY_AFTER_MS = 90_000;   // 1.5 min idle → drowsy
const DOZING_AFTER_MS = 240_000;  // 4 min idle → dozing (locked snooze loop)

// v0.16.0 — "Clippy is working" animation pool. Cycles continuously while
// the brain is mid-task so the user sees activity instead of a frozen
// paperclip during long tool chains (30s olk-direct-send, 60s word_to_pdf).
// v0.16.2 — trimmed pool. Processing + Thinking + CheckingSomething are
// visually distinct "I'm thinking" anims. GetTechy/Writing/GetWizardy/
// Searching are more energetic and were firing every ~2s during ANY tool
// call, making short replies (5s think) look like a slot-machine. Keep
// the energetic ones available via playNamed but don't cycle them.
const WORKING_ANIMS = ['Processing', 'Thinking', 'CheckingSomething'];

// v0.16.1 — minimum gap before the SAME idle animation can play again.
// Without this, weighted-random can still produce visible repeats (RestPose
// → RestPose → RestPose looks broken even if statistically correct).
const SAME_ANIM_MIN_GAP_MS = 25_000;

export class ClippyController {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sprite: HTMLImageElement;
  private agentData: AgentData;
  private currentAnimation: string = 'Idle1_1';
  private frameIndex: number = 0;
  private animTimer: number | null = null;
  private idleCycleTimer: number | null = null;
  private isLoaded: boolean = false;
  private isPlayingAction: boolean = false;
  private isSleeping: boolean = false;
  // v0.16.0 — "working" mode: when true, after each animation completes the
  // controller picks another from WORKING_ANIMS instead of returning to idle.
  // Set via startWorkingLoop() / cleared via stopWorkingLoop().
  private isWorking: boolean = false;
  private workingCycleTimer: number | null = null;

  // v0.16.1 — mood + cascade state
  private mood: Mood = 'neutral';
  private lastIdlePlayedAt: Record<string, number> = {};
  // last time the cursor moved meaningfully OR user interacted. Drives the
  // drowsy/dozing cascade. Set on construct to avoid instant-drowsy on launch.
  private lastActivityAt: number = Date.now();

  constructor(canvas: HTMLCanvasElement, spriteSrc: string, agentData: AgentData) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.agentData = agentData;

    const [fw, fh] = agentData.framesize;
    this.canvas.width = fw;
    this.canvas.height = fh;

    this.sprite = new Image();
    this.sprite.onload = () => {
      console.log('[Clippy] Sprite loaded:', this.sprite.width, 'x', this.sprite.height);
      this.isLoaded = true;
      this.play('Idle1_1');
      this.startIdleCycle();
    };
    this.sprite.onerror = (err) => {
      console.error('[Clippy] Failed to load sprite:', err);
    };
    this.sprite.src = spriteSrc;
  }

  play(animationName: string): void {
    if (!this.isLoaded) return;
    const anim = this.agentData.animations[animationName];
    if (!anim) {
      console.warn(`[Clippy] Animation not found: ${animationName}, falling back to Idle1_1`);
      if (animationName !== 'Idle1_1') {
        this.play('Idle1_1');
      }
      return;
    }
    this.currentAnimation = animationName;
    this.frameIndex = 0;
    this.stopAnimTimer();
    this.renderFrame();
  }

  playAction(animationName: string): void {
    this.isPlayingAction = true;
    this.stopIdleCycle();
    this.play(animationName);
  }

  private renderFrame(): void {
    const anim = this.agentData.animations[this.currentAnimation];
    if (!anim || this.frameIndex >= anim.frames.length) {
      // Animation ended — return to idle cycle, OR cycle to next working
      // animation if we're mid-task. v0.16.0 fix: previously Clippy froze
      // for ~27s during a 30s tool because the in-progress animation
      // (Thinking / Processing) finished in 3s and the controller went
      // back to idle even though the brain was still working.
      this.isPlayingAction = false;
      if (this.isWorking) {
        this.playRandomWorking();
        return;
      }
      this.startIdleCycle();
      this.playRandomIdle();
      return;
    }

    const frame = anim.frames[this.frameIndex];
    if (!frame || !frame.images || !Array.isArray(frame.images)) {
      // Skip bad frame
      this.frameIndex++;
      this.animTimer = window.setTimeout(() => this.renderFrame(), 100);
      return;
    }

    const [fw, fh] = this.agentData.framesize;
    this.ctx.clearRect(0, 0, fw, fh);

    try {
      for (const img of frame.images) {
        if (!Array.isArray(img) || img.length < 2) continue;
        const [sx, sy] = img;
        this.ctx.drawImage(this.sprite, sx, sy, fw, fh, 0, 0, fw, fh);
      }
    } catch (err) {
      console.error('[Clippy] Draw error:', err);
    }

    this.frameIndex++;
    const duration = frame.duration > 0 ? frame.duration : 100;
    this.animTimer = window.setTimeout(() => this.renderFrame(), duration);
  }

  // v0.16.1 — replaces flat uniform pick with mood × circadian × min-gap
  // weighted random selection. Brain-emitted mood (from main.ts interaction
  // tracker) flows in via setMood; hour-of-day is read here.
  private playRandomIdle(): void {
    // Sleeping (real brain-driven sleep) — keep prior behavior, lock to SLEEP_IDLES.
    if (this.isSleeping) {
      const available = SLEEP_IDLES.filter((a) => a in this.agentData.animations);
      const pick = available[Math.floor(Math.random() * available.length)] || 'Idle1_1';
      this.play(pick);
      return;
    }

    // Dozing (cascade-driven sleep) — same effect as real sleep, but reversible
    // by activity instead of a brain wake() call. Cleaner UX than calling
    // brain.sleep() which would also gate IPC + TTS off.
    if (this.mood === 'dozing') {
      const pick = ('IdleSnooze' in this.agentData.animations) ? 'IdleSnooze' : 'RestPose';
      this.play(pick);
      return;
    }

    const now = Date.now();
    const hour = new Date().getHours();
    const moodMult = MOOD_MULT[this.mood] || {};
    const circ = circadianMult(hour);

    const candidates: Array<{ name: string; weight: number }> = [];
    for (const [name, base] of Object.entries(IDLE_BASE_WEIGHTS)) {
      if (!(name in this.agentData.animations)) continue;
      // Min-gap: if this anim played within SAME_ANIM_MIN_GAP_MS, zero its weight.
      const last = this.lastIdlePlayedAt[name] || 0;
      if (now - last < SAME_ANIM_MIN_GAP_MS) continue;

      const mMult = moodMult[name] ?? 1;
      const cMult = circ[name] ?? 1;
      const weight = base * mMult * cMult;
      if (weight > 0) candidates.push({ name, weight });
    }

    if (candidates.length === 0) {
      // All animations on cooldown OR missing — fallback to safe default
      this.play('Idle1_1');
      this.lastIdlePlayedAt['Idle1_1'] = now;
      return;
    }

    const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
    let roll = Math.random() * totalWeight;
    let pick = candidates[0].name;
    for (const c of candidates) {
      roll -= c.weight;
      if (roll <= 0) { pick = c.name; break; }
    }

    this.lastIdlePlayedAt[pick] = now;
    this.play(pick);
  }

  private startIdleCycle(): void {
    this.stopIdleCycle();
    const delay = IDLE_CYCLE_MIN + Math.random() * (IDLE_CYCLE_MAX - IDLE_CYCLE_MIN);
    this.idleCycleTimer = window.setTimeout(() => {
      if (!this.isPlayingAction) {
        this.playRandomIdle();
        this.startIdleCycle();
      }
    }, delay);
  }

  private stopIdleCycle(): void {
    if (this.idleCycleTimer !== null) {
      clearTimeout(this.idleCycleTimer);
      this.idleCycleTimer = null;
    }
  }

  private stopAnimTimer(): void {
    if (this.animTimer !== null) {
      clearTimeout(this.animTimer);
      this.animTimer = null;
    }
  }

  sleep(): void {
    this.isSleeping = true;
    this.isPlayingAction = false;
    // Play GoodBye transition, then cycle sleep idles
    this.playAction('GoodBye');
  }

  wake(): void {
    this.isSleeping = false;
    this.isPlayingAction = false;
    // Play Show/Greeting transition, then cycle awake idles
    if ('Show' in this.agentData.animations) {
      this.playAction('Show');
    } else if ('Greeting' in this.agentData.animations) {
      this.playAction('Greeting');
    } else {
      this.playAction('Wave');
    }
  }

  // v0.16.0 — task-in-progress loop. Brain.ts emits 'working-start' when a
  // tool chain begins and 'working-stop' when it ends; the controller
  // continuously cycles WORKING_ANIMS in between so the user always sees
  // Clippy doing SOMETHING.
  startWorkingLoop(): void {
    if (this.isWorking) return;
    this.isWorking = true;
    this.stopIdleCycle();
    this.playRandomWorking();
  }

  stopWorkingLoop(): void {
    if (!this.isWorking) return;
    this.isWorking = false;
    if (this.workingCycleTimer !== null) {
      clearTimeout(this.workingCycleTimer);
      this.workingCycleTimer = null;
    }
    // Don't snap-cut — let the current animation finish, the renderFrame
    // tail will route back to idle since isWorking is now false.
  }

  private playRandomWorking(): void {
    const available = WORKING_ANIMS.filter((a) => a in this.agentData.animations);
    if (available.length === 0) {
      this.play('Thinking');
      return;
    }
    const pick = available[Math.floor(Math.random() * available.length)];
    // Use play() directly (not playAction) so we don't toggle the
    // isPlayingAction flag that would interfere with renderFrame tail logic.
    this.currentAnimation = pick;
    this.frameIndex = 0;
    this.stopAnimTimer();
    this.renderFrame();
  }

  wave(): void { this.playAction('Wave'); }
  think(): void { this.playAction('Thinking'); }
  suggest(): void { this.playAction('GetAttention'); }
  idle(): void { this.play('Idle1_1'); }
  getAttention(): void { this.playAction('GetAttention'); }
  congratulate(): void { this.playAction('Congratulate'); }
  alert(): void { this.playAction('Alert'); }
  write(): void { this.playAction('Writing'); }
  search(): void { this.playAction('Searching'); }

  /**
   * Play any named animation from the sprite (43+ available).
   * Previously this had a 10-entry whitelist that silently fell back to Idle1_1
   * for any unknown animation — which meant brain.ts could only ever use ~10
   * of Clippy's animations. Now any name from agentData.animations works;
   * play() falls back to Idle1_1 for truly unknown names with a warning.
   */
  playNamed(name: string): void {
    if (!name) return;
    // Idles cycle passively; non-idles are "actions" that stop the idle loop.
    if (name.startsWith('Idle') || name === 'RestPose') {
      this.play(name);
    } else {
      this.playAction(name);
    }
  }

  // ── v0.16.1 — Mood / activity / sleep cascade public surface ──────────

  /**
   * Update mood from the renderer-side interaction tracker. Caller is
   * src/renderer/main.ts which counts clicks + onSpeak events in a rolling
   * 1hr window. Drowsy/dozing are managed internally — caller should pass
   * neutral/happy/grumpy only; passing drowsy/dozing is allowed but
   * non-idiomatic (use noteActivity() to clear cascade instead).
   */
  setMood(m: Mood): void {
    this.mood = m;
  }

  getMood(): Mood {
    return this.mood;
  }

  /**
   * Called by the cursor-pos pump in main.ts on every meaningful cursor
   * delta and by the bubble controller on every user message. Resets the
   * sleep cascade — if Clippy was drowsy/dozing he perks back up.
   *
   * Note: this only manages cascade-driven sleep states (drowsy/dozing).
   * Brain-driven real sleep (isSleeping) is untouched — the user
   * explicitly putting Clippy to sleep via tray should not be overridden
   * by mouse movement.
   */
  noteActivity(): void {
    this.lastActivityAt = Date.now();
    if (this.mood === 'drowsy' || this.mood === 'dozing') {
      // Snap back to neutral; main.ts's interaction tracker will re-elevate
      // to happy/grumpy on its next tick if warranted.
      this.mood = 'neutral';
    }
  }

  /**
   * Called periodically (~once/sec) from the cursor-pos pump in main.ts.
   * Reads idle-since timestamp and steps Clippy down the cascade ladder.
   * Pure renderer logic — no IPC, no brain involvement. Safe to call
   * even while working/sleeping (no-ops in those cases).
   */
  tickSleepCascade(): void {
    if (this.isSleeping || this.isWorking) return;
    const idleFor = Date.now() - this.lastActivityAt;
    if (idleFor >= DOZING_AFTER_MS && this.mood !== 'dozing') {
      this.mood = 'dozing';
    } else if (idleFor >= DROWSY_AFTER_MS && idleFor < DOZING_AFTER_MS && this.mood !== 'drowsy') {
      // Only auto-set drowsy if not already in a stronger user-mood. Happy
      // shouldn't get overridden by 90s idle (user might be reading their
      // last reply); grumpy gives way to drowsy as a softer state.
      if (this.mood === 'neutral' || this.mood === 'grumpy') {
        this.mood = 'drowsy';
      }
    }
  }
}
