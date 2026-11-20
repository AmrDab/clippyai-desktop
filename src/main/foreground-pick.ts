/**
 * foreground-pick.ts — which window is "the app the user is on" (Windows).
 *
 * While the user types in Clippy's bubble, Clippy is the foreground window, so
 * the scripts walked down the Z-order to the first visible, titled window of
 * another process. On a PC with an always-on-top overlay (a notch bar, a HUD,
 * a screen-recorder frame) that window is the overlay: every task's
 * activeProcessAtStart was the overlay, and read_screen read it instead of the
 * user's email. get-foreground-window.ps1 now reports the windows as they are
 * (styles included) and this module picks. Pure (no Electron) so it unit-tests.
 */

export interface WinCandidate {
  handle: number;
  processId: number;
  processName: string;
  title: string;
  /** GWL_EXSTYLE */
  exStyle: number;
  /** GWL_STYLE */
  style: number;
  minimized?: boolean;
  /** Physical pixels. */
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ForegroundSnapshot {
  /** GetForegroundWindow(). 0 when there is none. */
  foreground: number;
  /** Visible, not cloaked, front to back. */
  candidates: WinCandidate[];
}

const WS_CAPTION = 0x00c00000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_NOACTIVATE = 0x08000000;

const has = (v: number, flag: number): boolean => (v & flag) === flag;

/** Small enough to be a badge, a bar or a bubble rather than an app window. */
function isSmall(b: WinCandidate['bounds']): boolean {
  return b.width <= 320 || b.height <= 320 || b.width * b.height <= 500_000;
}

/**
 * Why this window is not an app the user works in, or null when it is one.
 *   tool_window         WS_EX_TOOLWINDOW (taskbar, palettes, tray flyouts)
 *   topmost_noactivate  always on top and never takes focus (overlays, HUDs)
 *   click_through       layered + transparent: the mouse goes through it
 *   small_overlay       no WS_EX_APPWINDOW, always on top, no title bar, small
 */
export function overlayReason(w: Pick<WinCandidate, 'exStyle' | 'style' | 'bounds'>): string | null {
  const ex = w.exStyle >>> 0;
  if (has(ex, WS_EX_TOOLWINDOW)) return 'tool_window';
  if (has(ex, WS_EX_TOPMOST) && has(ex, WS_EX_NOACTIVATE)) return 'topmost_noactivate';
  if (has(ex, WS_EX_LAYERED) && has(ex, WS_EX_TRANSPARENT)) return 'click_through';
  if (!has(ex, WS_EX_APPWINDOW) && has(ex, WS_EX_TOPMOST) && !has(w.style >>> 0, WS_CAPTION) && isSmall(w.bounds)) return 'small_overlay';
  return null;
}

const isOwn = (w: WinCandidate, ownPid: number): boolean => w.processId === ownPid;
const usable = (w: WinCandidate, ownPid: number): boolean =>
  w.processId !== 0 && !isOwn(w, ownPid) && !w.minimized && w.bounds.width > 0 && w.bounds.height > 0 && overlayReason(w) === null;

/**
 * The window the user is on:
 *   1. the foreground window, unless it is Clippy's own or an overlay;
 *   2. else the first real app window (titled) down the Z-order;
 *   3. else the foreground window anyway, if it is not Clippy's own (better
 *      an odd window than none);
 *   4. else null.
 */
export function pickUserWindow(snap: ForegroundSnapshot, ownPid: number): WinCandidate | null {
  const fg = snap.candidates.find((w) => w.handle === snap.foreground);
  if (fg && usable(fg, ownPid)) return fg;
  const next = snap.candidates.find((w) => usable(w, ownPid) && w.title.trim().length > 0);
  if (next) return next;
  return fg && !isOwn(fg, ownPid) ? fg : null;
}

/** The script's output when it is the v0.24.12 snapshot; null for anything else (an older shape, an error). */
export function parseForegroundSnapshot(json: string): ForegroundSnapshot | null {
  try {
    const p = JSON.parse(json) as Partial<ForegroundSnapshot>;
    if (p && typeof p.foreground === 'number' && Array.isArray(p.candidates)) return { foreground: p.foreground, candidates: p.candidates };
  } catch { /* not JSON */ }
  return null;
}

/** get_active_window's JSON for the picked window: the shape the tool has always returned. */
export function activeWindowJson(w: WinCandidate): string {
  return JSON.stringify({ handle: w.handle, processId: w.processId, processName: w.processName, title: w.title, bounds: w.bounds, success: true });
}
