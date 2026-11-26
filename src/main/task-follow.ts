/**
 * task-follow.ts — while a user task runs, Clippy stays in front, where he is.
 *
 * He does NOT move with the cursor during a task (owner report on 0.24.9: "kept
 * following my cursor when he was doing a step, very annoying — just stay in
 * the foreground"). The 0.24.9 easing loop is gone, and with it the
 * setBounds "conversion failure" it threw on a 375% display.
 *
 * The user's own cursor-follow (follow-me.ts) is paused for the task and
 * resumed after, so nothing moves him while he works. window-follow already
 * skips ticks while a task runs.
 *
 * A slow timer re-asserts the z-order: a task focuses other windows (Settings,
 * Outlook), and some of those are topmost too. No timer exists outside
 * begin()..end(). The lifecycle takes injected deps so it is unit-tested with fakes.
 */

// Static on purpose: electron-vite inlines follow-me into index.js (brain.ts imports it
// statically), so a lazy require('./follow-me') points at a chunk that is never emitted
// and threw 'Cannot find module' in the packaged app (Mac live test, 0.24.7).
import * as followMe from './follow-me';
// Named, not followMe.setTaskHold(): it runs at import time, and the tool-tiers
// test bundle stubs follow-me, where only named imports resolve.
import { setTaskHold } from './follow-me';

export const TASK_FRONT_INTERVAL_MS = 1000;

export interface TaskFollowWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  showInactive(): void;
  moveTop(): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setVisibleOnAllWorkspaces?(visible: boolean, opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void;
}

export interface TaskFollowDeps {
  platform: string;
  followMeActive(): boolean;
  followMeStop(): void;
  followMeResume(win: TaskFollowWindow): void;
}

export function createTaskFollow(deps: TaskFollowDeps) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let win: TaskFollowWindow | null = null;
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
    raise(w);
  }

  function begin(target: TaskFollowWindow): void {
    if (timer) return; // one task at a time; idempotent
    win = target;
    resumeFollowMe = deps.followMeActive();
    if (resumeFollowMe) deps.followMeStop();
    raise(target);
    timer = setInterval(tick, TASK_FRONT_INTERVAL_MS);
  }

  /** Stop. He stays where he is; the user's own cursor-follow resumes. */
  function end(): void {
    if (timer) { clearInterval(timer); timer = null; }
    const w = win;
    win = null;
    if (resumeFollowMe && w && !w.isDestroyed()) {
      try { deps.followMeResume(w); } catch { /* non-fatal */ }
    }
    resumeFollowMe = false;
  }

  /**
   * A follow-me start while the task runs (the model's follow_me tool, the
   * tray): don't chase the cursor now, start it at end(). False when no task runs.
   */
  function deferFollowMe(): boolean {
    if (!timer) return false;
    resumeFollowMe = true;
    return true;
  }

  /**
   * The user stopped following during the task: don't start it at end().
   * Only while the task runs: begin() itself stops follow-me before the timer
   * exists, and that stop must keep the resume it just recorded.
   */
  function cancelFollowMe(): void {
    if (timer) resumeFollowMe = false;
  }

  return { begin, end, raise, deferFollowMe, cancelFollowMe, isActive: () => timer !== null };
}

// ── Production wiring (follow-me) ────────────────────────────────────────────

export const taskFollow = createTaskFollow({
  platform: process.platform,
  followMeActive: () => followMe.isActive(),
  followMeStop: () => followMe.stop('task'),
  followMeResume: (w) => followMe.start(w as unknown as import('electron').BrowserWindow, undefined, 'task-end'),
});
setTaskHold({ defer: () => taskFollow.deferFollowMe(), cancel: () => taskFollow.cancelFollowMe() });
