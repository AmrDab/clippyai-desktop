/**
 * task-follow.ts — while a user task runs, Clippy stays in front and travels
 * with the cursor (the owner report: "not in foreground, make sure he moves
 * with cursor when doing a task").
 *
 * Independent of the user's cursor-follow (follow-me.ts) and window-follow
 * settings, which keep applying outside tasks: begin() pauses follow-me and
 * end() resumes it. window-follow already skips ticks while a task runs, so
 * the two never fight.
 *
 * Placement is NOT follow-me's raw offset (220/120 puts the cursor inside the
 * 340px-wide window): the window is parked beside the cursor with a gap, so it
 * never sits on the point being clicked. If it ever does (the agent jumped the
 * cursor), the next tick snaps it aside instead of easing.
 *
 * No timer exists outside begin()..end(). Pure placement math is exported and
 * the lifecycle takes injected deps so it is unit-tested with fakes.
 */

// Static on purpose: electron-vite inlines follow-me into index.js (brain.ts imports it
// statically), so a lazy require('./follow-me') points at a chunk that is never emitted
// and threw 'Cannot find module' in the packaged app (Mac live test, 0.24.7).
import * as followMe from './follow-me';

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** Gap kept between the cursor and the window edge. */
export const TASK_FOLLOW_GAP = 40;
/** A window closer than this to the cursor counts as "in the way". */
export const TASK_FOLLOW_CLEAR = 24;
export const TASK_FOLLOW_INTERVAL_MS = 40;

function clamp(rect: Rect, wa: Rect): Rect {
  return {
    x: Math.round(Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - rect.width)),
    y: Math.round(Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}

/** True when the cursor is inside the rect grown by `margin`. */
export function coversPoint(rect: Rect, p: Pt, margin = TASK_FOLLOW_CLEAR): boolean {
  return p.x >= rect.x - margin && p.x <= rect.x + rect.width + margin
    && p.y >= rect.y - margin && p.y <= rect.y + rect.height + margin;
}

/**
 * Where the window should sit: bottom-right of the cursor, then bottom-left,
 * top-right, top-left — the first whose work-area-clamped rect stays clear of
 * the cursor. Falls back to bottom-right clamped if none is clear.
 */
export function taskFollowTarget(cursor: Pt, size: { width: number; height: number }, wa: Rect, gap = TASK_FOLLOW_GAP): Pt {
  const { width: w, height: h } = size;
  const candidates: Pt[] = [
    { x: cursor.x + gap, y: cursor.y + gap },
    { x: cursor.x - gap - w, y: cursor.y + gap },
    { x: cursor.x + gap, y: cursor.y - gap - h },
    { x: cursor.x - gap - w, y: cursor.y - gap - h },
  ];
  for (const c of candidates) {
    const r = clamp({ ...c, width: w, height: h }, wa);
    if (!coversPoint(r, cursor)) return { x: r.x, y: r.y };
  }
  const r = clamp({ ...candidates[0], width: w, height: h }, wa);
  return { x: r.x, y: r.y };
}

export interface TaskFollowWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  showInactive(): void;
  moveTop(): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setVisibleOnAllWorkspaces?(visible: boolean, opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void;
  getBounds(): Rect;
  setBounds(r: Rect): void;
}

export interface TaskFollowDeps {
  cursor(): Pt;
  workAreaNear(p: Pt): Rect;
  platform: string;
  followMeActive(): boolean;
  followMeStop(): void;
  followMeResume(win: TaskFollowWindow): void;
}

export function createTaskFollow(deps: TaskFollowDeps) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let win: TaskFollowWindow | null = null;
  let easing = 0.18;
  let ex = 0;
  let ey = 0;
  let lastX = 0;
  let lastY = 0;
  let resumeFollowMe = false;

  /** Raise to front without stealing focus. Safe to call repeatedly. */
  function raise(w: TaskFollowWindow): void {
    try {
      if (w.isDestroyed()) return;
      w.setAlwaysOnTop(true, 'screen-saver');
      // macOS: a native full-screen app lives on its own Space; the window must
      // join every Space (and full-screen ones) or it stays on the old desktop.
      // skipTransformProcessType keeps the Dock icon and menu bar.
      if (deps.platform === 'darwin') w.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      if (!w.isVisible()) w.showInactive();
      w.moveTop();
    } catch { /* best effort — never fail a task over z-order */ }
  }

  function tick(): void {
    const w = win;
    if (!w || w.isDestroyed()) { end(); return; }
    const cursor = deps.cursor();
    const b = w.getBounds();
    const target = taskFollowTarget(cursor, b, deps.workAreaNear(cursor));
    // Someone else moved/resized him (bubble expand, user drag): re-seed.
    if (Math.abs(b.x - lastX) > 2 || Math.abs(b.y - lastY) > 2) { ex = b.x; ey = b.y; }
    if (coversPoint(b, cursor)) { ex = target.x; ey = target.y; }       // in the way: step aside now
    else { ex += (target.x - ex) * easing; ey += (target.y - ey) * easing; }
    const nx = Math.round(ex);
    const ny = Math.round(ey);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) { ex = b.x; ey = b.y; return; }
    if (nx === b.x && ny === b.y) { lastX = b.x; lastY = b.y; return; }
    w.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
    lastX = nx; lastY = ny;
    raise(w);
  }

  function begin(target: TaskFollowWindow, opts: { easing?: number } = {}): void {
    if (timer) return; // one task at a time; idempotent
    win = target;
    if (typeof opts.easing === 'number' && Number.isFinite(opts.easing)) easing = Math.min(1, Math.max(0.05, opts.easing));
    resumeFollowMe = deps.followMeActive();
    if (resumeFollowMe) deps.followMeStop();
    raise(target);
    const b = target.getBounds();
    ex = b.x; ey = b.y; lastX = b.x; lastY = b.y;
    timer = setInterval(tick, TASK_FOLLOW_INTERVAL_MS);
  }

  /** Stop. He stays where he ended up; the user's own cursor-follow resumes. */
  function end(): void {
    if (timer) { clearInterval(timer); timer = null; }
    const w = win;
    win = null;
    if (resumeFollowMe && w && !w.isDestroyed()) {
      try { deps.followMeResume(w); } catch { /* non-fatal */ }
    }
    resumeFollowMe = false;
  }

  return { begin, end, raise, isActive: () => timer !== null };
}

// ── Production wiring (electron + follow-me), resolved lazily ────────────────

/* eslint-disable @typescript-eslint/no-require-imports */
export const taskFollow = createTaskFollow({
  cursor: () => (require('electron') as typeof import('electron')).screen.getCursorScreenPoint(),
  workAreaNear: (p) => (require('electron') as typeof import('electron')).screen.getDisplayNearestPoint(p).workArea,
  platform: process.platform,
  followMeActive: () => followMe.isActive(),
  followMeStop: () => followMe.stop('task'),
  followMeResume: (w) => followMe.start(w as unknown as import('electron').BrowserWindow, undefined, 'task-end'),
});
