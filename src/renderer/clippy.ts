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

const AWAKE_IDLES = ['Idle1_1', 'IdleRopePile', 'IdleAtom', 'IdleSideToSide', 'IdleHeadScratch', 'IdleFingerTap', 'IdleEyeBrowRaise'];
const SLEEP_IDLES = ['IdleSnooze', 'RestPose'];
const IDLE_CYCLE_MIN = 8000;
const IDLE_CYCLE_MAX = 15000;

// v0.16.0 — "Clippy is working" animation pool. Cycles continuously while
// the brain is mid-task so the user sees activity instead of a frozen
// paperclip during long tool chains (30s olk-direct-send, 60s word_to_pdf).
const WORKING_ANIMS = ['Processing', 'CheckingSomething', 'GetTechy', 'Writing', 'Searching', 'GetWizardy'];
const WORKING_CYCLE_MIN = 1800;
const WORKING_CYCLE_MAX = 3200;

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

  private playRandomIdle(): void {
    const pool = this.isSleeping ? SLEEP_IDLES : AWAKE_IDLES;
    const available = pool.filter((a) => a in this.agentData.animations);
    if (available.length === 0) {
      this.play('Idle1_1');
      return;
    }
    const pick = available[Math.floor(Math.random() * available.length)];
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
}
