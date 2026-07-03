/**
 * window-follow.ts — v0.20.0-alpha.13
 *
 * Makes Clippy's main window glide to the bottom-right corner of whatever
 * window the user is currently HOVERING (cursor under), so he doesn't seem
 * "stuck" on the wrong monitor or behind the new active app. Falls back to
 * the focused window if the bridge can't enumerate windows.
 *
 * Mirrors the singleton pattern used by follow-me.ts (cursor follow): a
 * single module-level interval at 1Hz that samples (a) the cursor position
 * and (b) the front-to-back window stack, picking the topmost window whose
 * bounds contain the cursor.
 *
 * Design decisions:
 *  - 1Hz poll, not event-driven. NSWorkspace notifications fire only on app
 *    switches, not window-within-app switches (e.g. Cmd-` between two
 *    Chrome windows) and never fire on pure hover. Polling at 1Hz catches
 *    all three with negligible cost (~0.5% of one core on M1) and no white
 *    "Screen captured" flash since CGWindowList + cursor reads are
 *    AX/permission-free at layer 0.
 *  - Cursor-hover strategy: get the cursor point, then walk the on-screen
 *    window list (sorted front-to-back by CG) and pick the first one whose
 *    bounds contain the cursor. If none match (cursor over Desktop), we
 *    fall back to the active window so Clippy still follows app-switches.
 *  - Manual-move cooldown (30s) overrides everything. If the user dragged
 *    Clippy themselves, we honour that placement until the cooldown
 *    expires — otherwise the auto-reposition feels hostile.
 *  - Skip during isExecuting=true so Clippy doesn't migrate mid-tool-call.
 *  - Skip while Clippy is asleep — a napping paperclip shouldn't chase
 *    windows. brain.getMode() === 'sleep' short-circuits the tick.
 *  - Skip ClippyAI itself, the Desktop (Finder/item-0 windows), and tiny
 *    pop-overs (<200×100). Skip fullscreen windows that cover the entire
 *    display — the bottom-right corner is obscured anyway and Clippy would
 *    just be hidden under the new app.
 *  - Multi-monitor: anchor in the screen-coordinate space of the display
 *    that the focused window is on (screen.getDisplayMatching(bounds)) and
 *    clamp the final position to that display's workArea.
 *  - Animate via setBounds(rect, true). On macOS this uses NSWindow's
 *    -setFrame:display:animate: → ~250ms ease-out. On win32 the boolean is
 *    ignored (instant snap, which is fine).
 */

import { BrowserWindow, screen, systemPreferences } from 'electron';
import { createLogger } from './logger';
import * as macBridge from './mac-bridge-native';
import * as takeover from './user-takeover';
import type { Brain } from './brain';

const log = createLogger('WindowFollow');

/**
 * Whether the OS "Reduce motion" accessibility setting is on. Used to decide
 * if the follow-glide should animate. Wrapped defensively: this runs on the
 * storm-sensitive follow path, so ANY failure falls back to `false` (animate
 * as before) rather than throwing into the tick loop.
 */
function prefersReducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion === true;
  } catch {
    return false;
  }
}

const POLL_INTERVAL_MS = 1000;
const MANUAL_COOLDOWN_MS = 30_000;
// Settle/dwell gate — the cursor must rest in a window THIS long before Clippy
// glides to it. Stops him chasing the cursor on every quick pass between
// windows, but short enough that a deliberate switch follows within ~1-2s
// (2.5s read as "not switching at all"). Tuned for "switch when I settle,
// ignore quick fly-throughs".
const SETTLE_DWELL_MS = 1000;
const OFFSET_X = 130; // px left of window's right edge — where Clippy anchors
const OFFSET_Y = 100; // px above window's bottom edge

// "Tiny window" guard — notification pop-overs, tooltips, etc. Don't chase.
const MIN_TARGET_W = 200;
const MIN_TARGET_H = 100;

// macOS process-name used to detect "ClippyAI itself is foreground". We skip
// the follow in that case so the bubble / Settings window doesn't drag the
// buddy to its own corner. Detection is name-based: activeWindow() does not
// return a bundle ID, so the app name is the only available signal.
const CLIPPY_APP_NAME = 'ClippyAI';

interface FollowState {
  enabled: boolean;
  lastManualMoveAt: number;
  lastTargetSignature: string; // app|x|y|w|h — skip if unchanged
  dwellKey: string;            // app|coarse-x|coarse-y of the window being settled on
  dwellSince: number;          // when the current dwellKey was first observed
  pollInterval: NodeJS.Timeout | null;
  win: BrowserWindow | null;
  brain: Brain | null;
}

const state: FollowState = {
  enabled: false,
  lastManualMoveAt: 0,
  lastTargetSignature: '',
  dwellKey: '',
  dwellSince: 0,
  pollInterval: null,
  win: null,
  brain: null,
};

interface ActiveWindowSample {
  app: string;
  bounds: { x: number; y: number; width: number; height: number };
  title?: string;
}

// ─── Hover-window cache ─────────────────────────────────────────────────────
//
// listWindows is slightly heavier than activeWindow (full CGWindowList walk
// + JSON serialise). At our 1Hz cadence the cost is negligible (~3-5ms on
// M1), but if a future change polls faster we don't want to thrash the
// Swift bridge — so we cache the most recent result for 250ms. Sized so it
// expires well within one 1s tick; at faster cadences ~4 ticks share a list.
const LIST_CACHE_TTL_MS = 250;
let cachedWindows: { result: macBridge.WindowsResult; at: number } | null = null;

async function listWindowsCached(): Promise<macBridge.WindowsResult | null> {
  const now = Date.now();
  if (cachedWindows && now - cachedWindows.at < LIST_CACHE_TTL_MS) {
    return cachedWindows.result;
  }
  try {
    const result = await macBridge.listWindows({ onScreenOnly: true });
    cachedWindows = { result, at: now };
    return result;
  } catch (err) {
    if (err instanceof macBridge.BridgeError) {
      log.debug('listWindows skipped', { kind: err.kind, msg: err.message });
    }
    return null;
  }
}

/**
 * Pick the topmost on-screen window whose bounds contain the given point.
 * The CGWindowList result is z-ordered front-to-back, so we return the
 * first match — that's the window the user is visually hovering. Returns
 * null if the cursor is over the Desktop (no window matches) or no list.
 *
 * We accept windows with non-empty bounds and layer 0 (already filtered by
 * the Swift side). We DON'T further filter by app name here — the
 * downstream isOwnApp / isDesktopWindow / size / fullscreen guards in
 * tick() handle that uniformly for both code paths.
 */
/**
 * Normalize bridge bounds to {x,y,width,height}. The native window manager
 * (WindowMgr.swift) emits short keys {x,y,w,h} for `windows`/`active-window`,
 * while the AX paths and the AxBounds type use {x,y,width,height}. Without this
 * coalescing, `b.width`/`b.height` were `undefined`, so EVERY follow tick failed
 * the finite-bounds guard ("skipping non-finite sample bounds") and Clippy never
 * moved to the window under the cursor. Accepts either shape.
 */
function normBounds(
  b: { x?: number; y?: number; width?: number; height?: number; w?: number; h?: number } | null | undefined,
): { x: number; y: number; width: number; height: number } | null {
  if (!b) return null;
  const x = b.x, y = b.y;
  const width = b.width ?? b.w;
  const height = b.height ?? b.h;
  if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
  return { x, y, width, height };
}

function windowUnderCursor(
  windows: macBridge.WindowInfo[],
  cx: number,
  cy: number,
): macBridge.WindowInfo | null {
  for (const w of windows) {
    if (w.layer !== 0) continue; // belt-and-braces; Swift already filters
    if (w.minimized) continue;
    if (w.alpha <= 0) continue;
    const b = normBounds(w.bounds);
    if (!b || b.width <= 0 || b.height <= 0) continue;
    if (cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height) {
      return w;
    }
  }
  return null;
}

async function sampleHoverDarwin(): Promise<ActiveWindowSample | null> {
  if (!macBridge.isBridgeAvailable()) return null;
  const list = await listWindowsCached();
  if (!list || !Array.isArray(list.windows) || list.windows.length === 0) return null;

  // Electron's cursor point is in DIP-screen coords, same coordinate space
  // as CGWindow bounds (top-left origin, points). Direct comparison is fine.
  const cursor = screen.getCursorScreenPoint();
  const hit = windowUnderCursor(list.windows, cursor.x, cursor.y);
  if (!hit) return null;

  const nb = normBounds(hit.bounds);
  if (!nb) return null;
  return {
    app: hit.app || '',
    bounds: nb,
    title: hit.title || '',
  };
}

async function sampleDarwin(): Promise<ActiveWindowSample | null> {
  if (!macBridge.isBridgeAvailable()) return null;
  // v0.20.0 — PRIMARY path is the FOCUSED / active window. "Switch between
  // windows" means changing focus (Cmd-Tab, clicking another window), not
  // moving the cursor — so Clippy follows the window you're actually working
  // in, regardless of where the pointer sits. (Previously this was cursor-
  // hover-primary, which meant focusing a window without moving the mouse into
  // it never moved Clippy — the "won't switch windows" complaint.)
  try {
    const w = await macBridge.activeWindow();
    if (w && w.bounds) {
      const nb = normBounds(w.bounds);
      if (nb) return { app: w.app || '', bounds: nb, title: w.title || '' };
    }
  } catch (err) {
    if (err instanceof macBridge.BridgeError) {
      log.debug('darwin active-window sample skipped', { kind: err.kind, msg: err.message });
    }
  }

  // Fallback — cursor hover, used only when the active window can't be
  // determined (rare). Keeps Clippy from freezing if activeWindow fails.
  const hover = await sampleHoverDarwin();
  if (hover) return hover;
  return null;
}

async function sampleActiveWindow(): Promise<ActiveWindowSample | null> {
  if (process.platform === 'darwin') return sampleDarwin();
  return null; // macOS port — win32/linux not shipped
}

function isOwnApp(sample: ActiveWindowSample): boolean {
  const app = (sample.app || '').toLowerCase();
  return app.includes(CLIPPY_APP_NAME.toLowerCase());
}

function isDesktopWindow(sample: ActiveWindowSample): boolean {
  // macOS: clicking the Desktop activates Finder with a window whose title
  // starts with "item-0" or similar (or is empty). We don't want Clippy to
  // "follow the Desktop" — live-tested 2026-06-11: he glided to (0,30) and
  // parked on top of Chrome's traffic lights.
  if (sample.app === 'Finder') {
    const title = (sample.title || '').toLowerCase();
    if (!title || title.startsWith('item-0')) return true;
    // Title check alone misses macOS versions where the desktop window
    // carries the wallpaper/Space name. The desktop's bounds span the
    // display minus the menu bar (~97% height) — just under isFullscreen's
    // 98% gate, which is exactly how the corner-bolt slipped through. Any
    // Finder "window" covering ≥90% of the primary display is the desktop,
    // not a browsing window.
    try {
      const d = screen.getPrimaryDisplay().bounds;
      const cov = (sample.bounds.width * sample.bounds.height) / (d.width * d.height);
      if (cov >= 0.9) return true;
    } catch { /* screen not ready — fall through to "not desktop" */ }
  }
  return false;
}

function isFullscreen(sample: ActiveWindowSample, displayBounds: { x: number; y: number; width: number; height: number }): boolean {
  const b = sample.bounds;
  // Treat as fullscreen if the window covers ≥98% of the display in both
  // dimensions. Tolerates a 1-2 px rounding in the AX bounds.
  const wPct = b.width / displayBounds.width;
  const hPct = b.height / displayBounds.height;
  return wPct >= 0.98 && hPct >= 0.98;
}

/**
 * Round a candidate {x,y,width,height} to integers, returning null if ANY
 * component is non-finite (NaN / Infinity / undefined). Pure + exported so the
 * storm guard can be unit-tested without an Electron BrowserWindow.
 *
 * This is the structural fix for the 18,544-line, ~29h "conversion failure"
 * storm in clippy-2026-05-27.log: a NaN reaching win.setBounds throws
 * synchronously, and at 1Hz inside the floating tick() that became a
 * process-level unhandledRejection flood. Returning null here lets tick() skip
 * the setBounds entirely rather than poison the follow loop.
 */
export function safeBoundsRect(
  target: { x: number; y: number } | null | undefined,
  winW: number,
  winH: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!target) return null;
  const rect = {
    x: Math.round(target.x),
    y: Math.round(target.y),
    width: Math.round(winW),
    height: Math.round(winH),
  };
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return null;
  }
  return rect;
}

function computeTarget(sample: ActiveWindowSample, win: BrowserWindow): { x: number; y: number } | null {
  const b = sample.bounds;
  const [winW, winH] = win.getSize();

  // Bottom-right of the target window, then offset so the paperclip
  // sprite overlaps the corner without obscuring the resize handle.
  const rawX = b.x + b.width - OFFSET_X;
  const rawY = b.y + b.height - OFFSET_Y;

  // Pick the display the target window lives on, clamp to its workArea so
  // Clippy never lands off-screen on multi-monitor setups.
  const display = screen.getDisplayMatching(b) || screen.getPrimaryDisplay();
  const wa = display.workArea;

  const clampedX = Math.max(wa.x, Math.min(wa.x + wa.width - winW, rawX));
  const clampedY = Math.max(wa.y, Math.min(wa.y + wa.height - winH, rawY));

  return { x: Math.round(clampedX), y: Math.round(clampedY) };
}

// Throttled diagnostic — logs why a tick didn't move Clippy. v0.20.0: demoted
// to DEBUG level (was INFO) so it no longer spams production logs; still
// available when debug logging is enabled to diagnose a "won't follow" report.
// The actual move is logged separately at info (WindowFollow.move).
let lastDiagAt = 0;
function diag(reason: string, extra?: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastDiagAt < 3000) return;
  lastDiagAt = now;
  log.debug('WindowFollow.diag', { reason, ...(extra || {}) });
}

async function tick(): Promise<void> {
  if (!state.enabled) return;
  const win = state.win;
  if (!win || win.isDestroyed()) return;

  // Cooldown — user dragged recently, respect their placement.
  const sinceManual = Date.now() - state.lastManualMoveAt;
  if (sinceManual < MANUAL_COOLDOWN_MS) return;

  // Sleep — a napping Clippy shouldn't chase windows. The user explicitly
  // asked for "in the same window where the cursor is (unless he is
  // asleep)". brain.getMode() returns 'sleep' while the eyes are closed
  // and 'awake' otherwise; see brain.ts:688.
  if (state.brain && state.brain.getMode() === 'sleep') {
    state.dwellKey = ''; // re-settle fresh on the next wake
    return;
  }

  // v0.20.0 — freeze ONLY during an actual input dispatch (the ~1.5s after a
  // mouse/keyboard event), NOT for the whole task. The old `isBusy()` gate
  // suppressed following for the entire task duration — and v4-pro's longer
  // thinking tasks made that "frozen" window long enough that Clippy visibly
  // stopped following focus. Between dispatches focus sits on the task's target
  // window anyway, so following keeps Clippy there; we only hold still for the
  // split-second it's clicking/typing so the bubble doesn't jump mid-action.
  if (takeover.isDispatchingInput()) { diag('dispatching_input'); return; }

  // NOTE: we deliberately do NOT bail when the bubble is open. Earlier that
  // hard guard meant Clippy never followed the focused window whenever a tip/
  // reply was up (and with the wake-watchdog keeping him awake, the bubble is
  // up a lot) — the #1 "won't switch windows" cause per WindowFollow.diag.
  // Safe to follow with the bubble open because: (a) while you're typing INTO
  // the bubble, ClippyAI is the focused app → isOwnApp below suppresses; and
  // (b) dwell+dedup only move on a genuine focus change, so a tip you're
  // reading in the SAME window isn't yanked. So Clippy (bubble and all) comes
  // with you when you switch windows. We still skip if the bubble is wider than
  // the work area would allow a clean placement — handled by the clamp later.

  const sample = await sampleActiveWindow();
  if (!sample) { diag('no_sample'); return; }
  if (isOwnApp(sample)) { diag('own_app', { app: sample.app }); return; }
  if (isDesktopWindow(sample)) { diag('desktop', { app: sample.app }); return; }

  const b = sample.bounds;
  // Validate the bounds from the native bridge BEFORE any Electron API touches
  // them. This is the true source of the 1Hz "conversion failure from …" storm:
  // when the bridge returns a malformed bounds field (e.g. a string with a
  // trailing newline, seen when the window query degrades), screen.getDisplayMatching(b)
  // below throws "Error processing argument at index 0" — UPSTREAM of the
  // safeBoundsRect guard that only protects setBounds. Skip the tick on any
  // non-finite field rather than poison the follow loop.
  if (![b.x, b.y, b.width, b.height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    log.warn('WindowFollow: skipping non-finite sample bounds', { app: sample.app, bounds: b });
    return;
  }
  if (b.width < MIN_TARGET_W || b.height < MIN_TARGET_H) return;

  const display = screen.getDisplayMatching(b) || screen.getPrimaryDisplay();
  if (isFullscreen(sample, display.bounds)) return;

  // Settle/dwell gate — don't follow a window the cursor is merely passing
  // through. We key the candidate window by app + a coarse 64px position
  // bucket (robust to title churn like "(1) Slack" / clocks, and to a few px
  // of bounds jitter). Only once the SAME window has been under the cursor for
  // SETTLE_DWELL_MS do we let the move proceed. Once Clippy is already on that
  // window the dedup below makes follow-up ticks no-ops, so this only gates the
  // initial glide to a newly-settled window — exactly "stay unless you mean it".
  const dwellKey = `${sample.app}|${Math.round(b.x / 64)}|${Math.round(b.y / 64)}`;
  const nowMs = Date.now();
  if (dwellKey !== state.dwellKey) {
    state.dwellKey = dwellKey;
    state.dwellSince = nowMs;
    diag('dwell_new', { app: sample.app });
    return; // new candidate window — wait for the cursor to settle
  }
  if (nowMs - state.dwellSince < SETTLE_DWELL_MS) { diag('dwell_wait', { app: sample.app }); return; } // still settling

  // De-duplicate: if the target window and bounds haven't changed since the
  // last tick, no need to re-issue setBounds.
  const sig = `${sample.app}|${b.x}|${b.y}|${b.width}|${b.height}`;
  if (sig === state.lastTargetSignature) { diag('already_on_window', { app: sample.app }); return; }
  state.lastTargetSignature = sig;

  const target = computeTarget(sample, win);
  if (!target) return;

  const [winW, winH] = win.getSize();
  const [curX, curY] = win.getPosition();
  // Skip if we're already within a few px of the target — avoids a no-op
  // setBounds that would still trigger the animate path.
  if (Math.abs(curX - target.x) < 4 && Math.abs(curY - target.y) < 4) { diag('already_positioned', { app: sample.app }); return; }

  log.info('WindowFollow.move', {
    app: sample.app,
    from: [curX, curY],
    to: [target.x, target.y],
  });
  // Guard against NaN/Infinity reaching Electron's native setBounds, which
  // throws "Error processing argument at index 0, conversion failure from …"
  // — a synchronous throw that, via the floating tick() in startWindowFollow,
  // was the root of the 1Hz unhandledRejection storm. If any dimension is not
  // a finite number safeBoundsRect returns null and we skip this tick rather
  // than poison the follow loop.
  const rect = safeBoundsRect(target, winW, winH);
  if (!rect) {
    log.warn('WindowFollow: skipping setBounds with non-finite rect', { target });
    return;
  }
  // Second arg = animate (macOS: ~250ms ease-out via NSWindow; win32: no-op).
  // Honour "Reduce motion": vestibular-sensitive users get an instant snap
  // instead of a glide across the screen (WCAG 2.3.3).
  win.setBounds(rect, !prefersReducedMotion());
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Begin the focused-window follow loop. Idempotent — calling twice replaces
 * the existing interval. brain is optional but recommended (used for the
 * getMode() sleep check so a napping Clippy doesn't chase windows).
 */
export function startWindowFollow(win: BrowserWindow, brain?: Brain | null): void {
  if (process.platform !== 'darwin') {
    log.info('startWindowFollow: unsupported platform, skipping', { platform: process.platform });
    return;
  }
  state.win = win;
  state.brain = brain || null;
  state.enabled = true;

  if (state.pollInterval) clearInterval(state.pollInterval);
  state.pollInterval = setInterval(() => {
    // tick is async; we deliberately don't await — interval cadence wins
    // over completion ordering, and tick is reentrancy-safe (no shared
    // state mutation except the lastTargetSignature, which is sequential).
    //
    // The rejection MUST be caught here. A `void tick()` floating promise at
    // 1Hz turns any throw inside tick() into a process-level
    // unhandledRejection — that was the source of the 18,544-line,
    // ~29h "conversion failure" storm in clippy-2026-05-27.log (a NaN reaching
    // win.setBounds threw synchronously inside tick with nothing to catch it).
    tick().catch((err) => {
      log.warn('WindowFollow.tick failed (non-fatal)', {
        err: err instanceof Error ? (err.stack || err.message) : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  log.info('WindowFollow started', { pollMs: POLL_INTERVAL_MS, cooldownMs: MANUAL_COOLDOWN_MS });
}

/** Stop the follow loop. Safe to call when not running. */
export function stopWindowFollow(): void {
  state.enabled = false;
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
  state.lastTargetSignature = '';
  state.dwellKey = '';
  log.info('WindowFollow stopped');
}

/**
 * Mark a manual user drag — pauses auto-follow for MANUAL_COOLDOWN_MS so
 * we don't fight the user's chosen placement. Called from the move-window
 * IPC handler in window.ts on every drag tick (cheap; just sets a number).
 */
export function noteManualMove(): void {
  state.lastManualMoveAt = Date.now();
}

/** True while the follow loop is active. */
export function isActive(): boolean {
  return state.enabled && state.pollInterval !== null;
}

/**
 * Live-toggle from Settings. When disabled, the interval keeps running but
 * tick() short-circuits — cheap, and re-enabling is instant.
 */
export function setEnabled(enabled: boolean): void {
  state.enabled = enabled;
  log.info('WindowFollow setEnabled', { enabled });
}
