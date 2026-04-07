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
      // Animation ended — return to idle cycle
      this.isPlayingAction = false;
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

  wave(): void { this.playAction('Wave'); }
  think(): void { this.playAction('Thinking'); }
  suggest(): void { this.playAction('Suggest'); }
  idle(): void { this.play('Idle1_1'); }
  getAttention(): void { this.playAction('GetAttention'); }
  congratulate(): void { this.playAction('Congratulate'); }
  alert(): void { this.playAction('Alert'); }
  write(): void { this.playAction('Writing'); }
  search(): void { this.playAction('Searching'); }

  playNamed(name: string): void {
    const map: Record<string, string> = {
      Wave: 'Wave',
      Suggest: 'Suggest',
      Think: 'Thinking',
      Thinking: 'Thinking',
      Idle: 'Idle1_1',
      GetAttention: 'GetAttention',
      Congratulate: 'Congratulate',
      Alert: 'Alert',
      Writing: 'Writing',
      Searching: 'Searching',
    };
    const anim = map[name] ?? 'Idle1_1';
    if (anim === 'Idle1_1') {
      this.play(anim);
    } else {
      this.playAction(anim);
    }
  }
}
