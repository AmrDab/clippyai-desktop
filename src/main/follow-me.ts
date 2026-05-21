/**
 * follow-me.ts — v0.19.0
 *
 * Singleton module that makes Clippy's window glide toward the user's cursor
 * with exponential easing. Activated via the follow_me tool, voice pattern
 * routing in brain.ts, or the tray menu. Deactivated via stop_following,
 * voice ("stop following"), Esc key (renderer → IPC → stop()), or sleep.
 *
 * Design decisions:
 *  - Module-level singleton state (avoids DI complexity, same pattern as
 *    cursor-poll in window.ts).
 *  - setMainWindow() called once at startup from index.ts; subsequent callers
 *    (tools, IPC) inherit the reference.
 *  - setInterval at 60ms (~16Hz) with a delta threshold to suppress
 *    micro-jitter when cursor is nearly stationary.
 *  - Screen-edge behaviour: park/clamp. The desired position is clamped to
 *    the workArea of the nearest display; easing decelerates toward the wall
 *    and stops there — no bounce, no bleed into adjacent monitors.
 *  - Multi-monitor: workArea is re-sampled every tick from
 *    screen.getDisplayNearestPoint(cursor), so Clippy adjusts when the cursor
 *    moves to a secondary display.
 */

import { screen, BrowserWindow } from 'electron';

export interface FollowMeOptions {
  /** Horizontal offset (px). Positive → cursor is left of Clippy. Default 220. */
  offsetX: number;
  /** Vertical offset (px). Positive → cursor is above Clippy. Default 120. */
  offsetY: number;
  /**
   * Easing factor 0.05–0.40. Applied each tick as:
   *   easedX += (target - easedX) * factor
   * Higher → snappier. Default 0.18.
   */
  easing: number;
  /** Polling interval in ms. Default 60 (~16Hz). */
  intervalMs: number;
  /**
   * Minimum cursor movement in px to trigger a window move. Suppresses
   * micro-jitter when cursor is nearly stationary. Default 6.
   */
  deltaThreshold: number;
}

export interface FollowMeState {
  active: boolean;
  options: FollowMeOptions;
  startedAt?: number;
  startReason?: string;
}

const DEFAULT_OPTIONS: FollowMeOptions = {
  offsetX: 220,
  offsetY: 120,
  easing: 0.18,
  intervalMs: 60,
  deltaThreshold: 6,
};

// ── Module-level singleton state ──────────────────────────────────────────────

let _win: BrowserWindow | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
let _opts: FollowMeOptions = { ...DEFAULT_OPTIONS };
let _easedX = 0;
let _easedY = 0;
let _startedAt: number | undefined;
let _startReason: string | undefined;

// ── Internal ──────────────────────────────────────────────────────────────────

function _tick(): void {
  if (!_win || _win.isDestroyed()) {
    _cleanup();
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x: wa_x, y: wa_y, width: wa_w, height: wa_h } = display.workArea;

  // Where we *want* the window — cursor minus offset so Clippy stays
  // to the right of and below the cursor by default.
  const rawTargetX = cursor.x - _opts.offsetX;
  const rawTargetY = cursor.y - _opts.offsetY;

  const bounds = _win.getBounds();
  const winW = bounds.width;
  const winH = bounds.height;

  // Clamp to workArea so Clippy parks at the edge instead of going off-screen.
  const targetX = Math.max(wa_x, Math.min(wa_x + wa_w - winW, rawTargetX));
  const targetY = Math.max(wa_y, Math.min(wa_y + wa_h - winH, rawTargetY));

  // Seed eased position from actual window position on first tick (or if
  // _easedX/_easedY haven't been initialised yet).
  if (_easedX === 0 && _easedY === 0) {
    _easedX = bounds.x;
    _easedY = bounds.y;
  }

  // Exponential easing toward target.
  _easedX += (targetX - _easedX) * _opts.easing;
  _easedY += (targetY - _easedY) * _opts.easing;

  const newX = Math.round(_easedX);
  const newY = Math.round(_easedY);

  // Skip setBounds if cursor hasn't moved enough to matter.
  if (Math.abs(newX - bounds.x) < _opts.deltaThreshold
      && Math.abs(newY - bounds.y) < _opts.deltaThreshold) {
    return;
  }

  _win.setBounds({ x: newX, y: newY, width: winW, height: winH });
}

function _cleanup(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
  _easedX = 0;
  _easedY = 0;
  _startedAt = undefined;
  _startReason = undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Inject the main BrowserWindow reference. Call once from index.ts after the
 * window is created so all subsequent callers (tools, IPC) share it.
 */
export function setMainWindow(win: BrowserWindow): void {
  _win = win;
}

/**
 * Start follow-me mode. Idempotent — if already active, updates options and
 * resets the eased position so the new options take effect immediately.
 *
 * @param win      Optional BrowserWindow override (falls back to setMainWindow).
 * @param opts     Partial option overrides (merged with current defaults).
 * @param reason   Free-form reason string logged with the start event.
 */
export function start(
  win?: BrowserWindow,
  opts?: Partial<FollowMeOptions>,
  reason?: string,
): void {
  if (win) _win = win;
  if (opts) _opts = { ..._opts, ...opts };

  // Stop any existing interval before starting fresh.
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }

  _easedX = 0; // will be seeded from actual bounds on first tick
  _easedY = 0;
  _startedAt = Date.now();
  _startReason = reason;

  _timer = setInterval(_tick, _opts.intervalMs);
}

/**
 * Stop follow-me mode and clear the polling interval.
 *
 * @param reason  Free-form reason string ('voice' | 'esc' | 'sleep' | 'manual').
 */
export function stop(reason?: string): void {
  void reason; // available for future telemetry
  _cleanup();
}

/** Returns true while the follow-me interval is running. */
export function isActive(): boolean {
  return _timer !== null;
}

/**
 * Live-update options without restarting. Takes effect on the next tick.
 * Useful for Settings → Brain → Follow Mode sliders.
 */
export function setOptions(next: Partial<FollowMeOptions>): void {
  _opts = { ..._opts, ...next };
}

/** Snapshot of current state for diagnostics / tray menu label. */
export function getState(): FollowMeState {
  return {
    active: isActive(),
    options: { ..._opts },
    startedAt: _startedAt,
    startReason: _startReason,
  };
}
