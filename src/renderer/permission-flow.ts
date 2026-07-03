export type PermKind = 'accessibility' | 'screenRecording' | 'automation';
export interface PermSnapshot {
  accessibility: boolean;
  screenRecording: boolean;
  automationAnyBrowser: boolean;
}
export type PermStatus = 'intro' | 'opened' | 'waiting' | 'granted' | 'done';
export interface FlowState {
  kind: PermKind | null;
  status: PermStatus;
  animation: 'Explain' | 'GestureRight' | 'Searching' | 'Congratulate' | 'Wave' | null;
  done: boolean;
  justGranted: boolean;
  needsRelaunch: boolean;
}

const WHY: Record<PermKind, string> = {
  accessibility: 'So I can click and type things for you.',
  screenRecording: 'So I can actually see your screen — read an error, a page, a doc.',
  automation: "So I can drive your browser. I'll only ask per app you picked.",
};

function isGranted(kind: PermKind, s: PermSnapshot): boolean {
  if (kind === 'accessibility') return s.accessibility;
  if (kind === 'screenRecording') return s.screenRecording;
  return s.automationAnyBrowser;
}

export class PermissionFlow {
  private order: PermKind[];
  private idx = 0;
  private status: PermStatus = 'intro';
  private justGranted = false;
  private needsRelaunch = false;
  private hasBrowser: boolean;

  constructor(order: PermKind[], opts: { hasBrowser?: boolean } = {}) {
    this.hasBrowser = opts.hasBrowser ?? true;
    // Drop automation entirely when no browser was selected.
    this.order = order.filter((k) => k !== 'automation' || this.hasBrowser);
  }

  start(snap: PermSnapshot): FlowState {
    this.idx = 0; this.status = 'intro'; this.justGranted = false; this.needsRelaunch = false;
    this.skipGranted(snap);
    return this.current();
  }

  /** Advance past any leading already-granted permissions. */
  private skipGranted(snap: PermSnapshot): void {
    while (this.idx < this.order.length && isGranted(this.order[this.idx], snap)) this.idx++;
  }

  current(): FlowState {
    if (this.idx >= this.order.length) {
      return { kind: null, status: 'done', animation: 'Wave', done: true, justGranted: false, needsRelaunch: this.needsRelaunch };
    }
    const kind = this.order[this.idx];
    let animation: FlowState['animation'];
    if (this.status === 'intro') animation = 'Explain';
    else if (this.status === 'opened') animation = 'GestureRight';
    else if (this.status === 'waiting') animation = 'Searching';
    else if (this.status === 'granted') animation = 'Congratulate';
    else animation = 'Wave';
    return { kind, status: this.status, animation, done: false, justGranted: this.justGranted, needsRelaunch: this.needsRelaunch };
  }

  why(kind: PermKind): string { return WHY[kind]; }

  open(): FlowState { this.status = 'opened'; this.justGranted = false; return this.current(); }

  /** Called on each poll snapshot while waiting. */
  onSnapshot(snap: PermSnapshot): FlowState {
    if (this.idx >= this.order.length) return this.current();
    if (this.status !== 'opened' && this.status !== 'waiting') return this.current(); // guard: only act while open/waiting
    const kind = this.order[this.idx];
    if (isGranted(kind, snap)) {
      this.status = 'granted';
      this.justGranted = true;
      if (kind === 'screenRecording') this.needsRelaunch = true;
    } else {
      if (this.status === 'opened') this.status = 'waiting'; // first ungranted poll → calm Searching
      this.justGranted = false;
    }
    return this.current();
  }

  advance(): FlowState {
    if (this.idx < this.order.length) this.idx++;
    this.status = 'intro'; this.justGranted = false;
    return this.current();
  }

  skip(): FlowState { return this.advance(); }
}
