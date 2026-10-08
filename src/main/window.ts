import { BrowserWindow, screen, ipcMain, Rectangle, Display } from 'electron';
import path from 'path';
import { createLogger } from './logger';
// v0.20.0-alpha.12 — static import (no cycle: window-follow only imports
// Brain type + electron; the agent's "lazy require avoids cycle" comment
// was a false alarm and that lazy require got tree-shaken in alpha.11).
import * as windowFollowMod from './window-follow';
import * as quitState from './quit-state';

const log = createLogger('Window');

let settingsWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;

// Small window sized to Clippy sprite — expands when bubble shows.
//
// v0.19.0 PR-2.1 — three target sizes to match the new adaptive bubble
// states (compact / standard / expanded). Pre-fix the window had only
// two sizes (140×110 collapsed, 320×380 expanded), but bubble v2's
// natural sizes (compact 280, standard 340, expanded 480) overflow
// the 320-wide expanded window — the left edge of the bubble's text
// was being clipped because Electron clips renderer content to window
// bounds. Each tier here is the bubble's natural width plus padding
// for Clippy's sprite footprint.
const CLIPPY_WIDTH = 140;
const CLIPPY_HEIGHT = 110;
const BUBBLE_COMPACT_WIDTH = 340;
const BUBBLE_COMPACT_HEIGHT = 200;
const BUBBLE_STANDARD_WIDTH = 380;
const BUBBLE_STANDARD_HEIGHT = 420;
const BUBBLE_EXPANDED_WIDTH = 540;
const BUBBLE_EXPANDED_HEIGHT = 660;
// Legacy aliases — kept so existing call sites that expect the old
// "expanded" semantic (= standard in the new vocabulary) still work.
const EXPANDED_WIDTH = BUBBLE_STANDARD_WIDTH;
const EXPANDED_HEIGHT = BUBBLE_STANDARD_HEIGHT;

type BubbleSizeState = 'collapsed' | 'compact' | 'standard' | 'expanded';

function dimsFor(state: BubbleSizeState): { width: number; height: number } {
  switch (state) {
    case 'collapsed': return { width: CLIPPY_WIDTH, height: CLIPPY_HEIGHT };
    case 'compact':   return { width: BUBBLE_COMPACT_WIDTH,  height: BUBBLE_COMPACT_HEIGHT  };
    case 'standard':  return { width: BUBBLE_STANDARD_WIDTH, height: BUBBLE_STANDARD_HEIGHT };
    case 'expanded':  return { width: BUBBLE_EXPANDED_WIDTH, height: BUBBLE_EXPANDED_HEIGHT };
  }
}

// ── v0.20.0-alpha.14 — anchor-aware bubble geometry ────────────────────
//
// Pre-fix the window grew by always shifting up + left, assuming Clippy
// lives in the screen's bottom-right corner. But the window is freely
// draggable AND window-follow.ts repositions it under whatever window the
// user hovers — so on the left/top edge or a second display the expanded
// bubble fell off-screen, the y=0 clamp pinned the top edge while the
// bubble CSS still drew below, and the collapse offset (recomputed from
// live size) drifted whenever a setBounds had been clamped, so Clippy
// "walked" across the screen over repeated show/hide.
//
// New model — Clippy's sprite is pinned to the window's BOTTOM-RIGHT
// corner (see #clippy-container in style.css). That sprite corner is the
// invariant we preserve across every resize:
//
//   anchor = (x + w, y + h)   // bottom-right of the window = Clippy
//
// On resize we keep `anchor` fixed and grow the bubble AWAY from it
// (up + left) by default, then clamp the resulting rect into the work
// area of the display the window actually sits on. If the grown rect
// can't fit above the anchor (Clippy near the top edge), we flip it to
// grow downward and tell the renderer so the tail flips too. The exact
// pre-expand origin is stored so collapse restores it verbatim rather
// than re-deriving it from a possibly-clamped size.

/** Which vertical side of Clippy the bubble body occupies. */
type BubbleSide = 'above' | 'below';

/** Clamp a rect so it lies fully within the display's work area. Shifts
 *  (never shrinks) the rect; callers size rects to fit a single display. */
function clampRectToDisplay(rect: Rectangle, display: Display): Rectangle {
  const wa = display.workArea;
  const x = Math.round(Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - rect.width));
  const y = Math.round(Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - rect.height));
  return { x, y, width: rect.width, height: rect.height };
}

/** The display the window's center currently sits on. */
function displayForWindow(win: BrowserWindow): Display {
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  return screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + h / 2) });
}

export function createWindow(): BrowserWindow {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  // Position above the taskbar with safe margin
  const xPos = Math.max(0, screenW - CLIPPY_WIDTH - 10);
  const yPos = Math.max(0, screenH - CLIPPY_HEIGHT - 10);

  log.debug('Screen geometry', { screenW, screenH, xPos, yPos, width: CLIPPY_WIDTH, height: CLIPPY_HEIGHT });

  const iconPath = path.join(__dirname, '../../build/icon.ico');

  const win = new BrowserWindow({
    width: CLIPPY_WIDTH,
    height: CLIPPY_HEIGHT,
    x: xPos,
    y: yPos,
    icon: iconPath,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // NO click-through — window always receives mouse events
  // Window is small enough that it only covers Clippy
  win.setIgnoreMouseEvents(false);

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.webContents.on('did-finish-load', () => {
    log.debug('Renderer loaded');
  });

  // v0.19.0 PR-2.1 / v0.20.0-alpha.14 — bubble-state-aware window sizing.
  //
  // The bubble can be in four visual modes; each needs a different window
  // dimension to render without clipping. We preserve Clippy's sprite
  // corner (the window's bottom-right) across every resize and grow the
  // bubble away from it, anchor/quadrant-aware (see the geometry comment
  // above clampRectToDisplay). Tracked state lives here, not in the
  // renderer, because bubble.ts may fire setState() faster than the resize
  // animation; main is the source of truth for "what size are we at now."
  let currentSize: BubbleSizeState = 'collapsed';
  // Exact pre-expand origin (top-left of the collapsed sprite window).
  // Captured the first time we leave 'collapsed' and restored verbatim on
  // the way back, so a clamped intermediate setBounds can't make Clippy
  // drift across the screen over repeated show/hide.
  let collapsedOrigin: { x: number; y: number } | null = null;
  // Which side the bubble body last rendered on, so we only message the
  // renderer when it actually flips.
  let currentSide: BubbleSide = 'above';

  function resizeTo(state: BubbleSizeState): void {
    if (win.isDestroyed()) return;
    if (state === currentSize) return; // idempotent
    const { width: newW, height: newH } = dimsFor(state);
    const [x, y] = win.getPosition();
    const [oldW, oldH] = win.getSize();
    const display = displayForWindow(win);

    if (state === 'collapsed') {
      // Restore the stored pre-expand origin verbatim. Falling back to the
      // bottom-right-preserving math only if we somehow never captured one
      // (e.g. first call is a collapse). Clamp so a display change while
      // expanded can't leave the sprite off-screen.
      const anchorRight = x + oldW;
      const anchorBottom = y + oldH;
      const origin = collapsedOrigin ?? { x: anchorRight - newW, y: anchorBottom - newH };
      const rect = clampRectToDisplay({ x: origin.x, y: origin.y, width: newW, height: newH }, display);
      log.debug('Bubble window collapse', { to: state, restored: origin, rect });
      win.setBounds(rect);
      collapsedOrigin = null;
      currentSize = state;
      setBubbleSide(win, 'above'); // collapsed sprite has no tail; reset for next open
      return;
    }

    // Growing (or moving between visible sizes). Capture the origin the
    // first time we leave 'collapsed' so collapse can restore it.
    if (currentSize === 'collapsed') collapsedOrigin = { x, y };

    // Preserve Clippy's sprite corner = the window's bottom-right.
    const anchorRight = x + oldW;
    const anchorBottom = y + oldH;
    let newX = anchorRight - newW;
    let newY = anchorBottom - newH; // grow upward by default
    let side: BubbleSide = 'above';

    // If growing upward would clip the top of the work area, flip and grow
    // downward from Clippy's top edge instead (tail points up).
    const wa = display.workArea;
    if (newY < wa.y && anchorBottom - oldH + newH <= wa.y + wa.height) {
      newY = anchorBottom - oldH; // keep Clippy's top edge, extend below
      side = 'below';
    }

    const rect = clampRectToDisplay({ x: newX, y: newY, width: newW, height: newH }, display);
    log.debug('Bubble window resize', { from: currentSize, to: state, oldSize: [oldW, oldH], newSize: [newW, newH], side, rect });
    win.setBounds(rect);
    currentSize = state;
    setBubbleSide(win, side);
  }

  // Tell the renderer which side the bubble body sits on so it can flip the
  // tail (.bubble--below). Only emits on an actual change.
  function setBubbleSide(w: BrowserWindow, side: BubbleSide): void {
    if (side === currentSide) return;
    currentSide = side;
    if (!w.isDestroyed()) w.webContents.send('bubble-side', side);
  }

  // v0.19.0 PR-2.1 — preferred IPC: renderer-driven resize keyed by
  // bubble state. The renderer calls this every time setState() runs.
  ipcMain.on('bubble-window-size', (_event, state: BubbleSizeState) => {
    if (state !== 'collapsed' && state !== 'compact' && state !== 'standard' && state !== 'expanded') {
      log.warn('bubble-window-size: bad state, ignoring', { state });
      return;
    }
    resizeTo(state);
  });

  // Legacy IPC channels — kept for backward compatibility with callers
  // that haven't migrated to the state-keyed channel yet.
  ipcMain.on('expand-window', () => resizeTo('standard'));
  ipcMain.on('collapse-window', () => resizeTo('collapsed'));

  // TODO(v0.20.x) — item #5: when expanded the host window (540×660) is
  // larger than the bubble body (480×600 pinned bottom-right), so its
  // transparent top-left margin swallows desktop clicks. The clean fix is
  // region-based setIgnoreMouseEvents(true, { forward: true }) over just
  // that transparent gutter, restored on collapse. Skipped for now: doing
  // it precisely needs the bubble's exact window-space rect (owned by the
  // renderer) pumped back to main, and a naive whole-window toggle breaks
  // the draggable sprite + bubble buttons. Tracked separately rather than
  // shipped half-done.

  // Window drag movement — with bounds checking
  ipcMain.on('move-window', (_event, deltaX: number, deltaY: number) => {
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    // v0.20.0-alpha.14 — clamp against the display the window is on, not
    // the primary display, so drags across a multi-monitor setup don't get
    // yanked back. Keep at least half the window on screen horizontally and
    // never let the top edge leave the work area.
    const target = { x: x + deltaX, y: y + deltaY };
    const display = screen.getDisplayNearestPoint({ x: Math.round(target.x + w / 2), y: Math.round(target.y + h / 2) });
    const wa = display.workArea;
    const newX = Math.max(wa.x - w / 2, Math.min(wa.x + wa.width - w / 2, target.x));
    const newY = Math.max(wa.y, Math.min(wa.y + wa.height - h / 2, target.y));
    win.setPosition(Math.round(newX), Math.round(newY));
    // The user is repositioning the sprite — its pre-expand origin is now
    // wherever they dropped it, so forget any stored collapse origin.
    if (currentSize === 'collapsed') collapsedOrigin = null;
    // v0.20.0-alpha.12 — bump the manual-move cooldown so the focused-
    // window follower respects the user's placement for the next 30s.
    // Static import below (no cycle — window-follow only imports brain
    // type + electron; not from window.ts) — prevents the Rollup tree-
    // shake that bit alpha.11. See memory: feedback-clippy-bundle-anchors.
    windowFollowMod.noteManualMove();
  });

  win.on('close', (e) => {
    // Hide-to-tray on the window's red-X (always-on assistant) — BUT never
    // block a genuine quit (tray/menu Quit, Cmd+Q, or the auto-updater's
    // quitAndInstall). Without this escape the app could only be Force-Quit
    // and updates hung forever waiting for a quit that the window refused.
    if (quitState.isQuitting()) return;
    e.preventDefault();
    win.hide();
  });

  mainBubbleWindow = win;
  return win;
}

/**
 * v0.20.0 — the main Clippy bubble window, captured in createWindow(). Lets
 * non-index modules (e.g. the play_animation tool) signal the sprite renderer
 * without threading the ref through every call site.
 */
let mainBubbleWindow: BrowserWindow | null = null;
export function getMainWindow(): BrowserWindow | null {
  return mainBubbleWindow && !mainBubbleWindow.isDestroyed() ? mainBubbleWindow : null;
}

// v0.16.0 — cursor position pump. Sends {cx, cy, mx, my} to renderer so
// Clippy can glance toward the cursor (cursor-look) and chase it (play-tag).
// Default: 1Hz (cursor-look only). startPlayTag() bumps to 30Hz briefly,
// stopPlayTag() returns to 1Hz. Cleaned up on win.destroy.
let cursorPollInterval: NodeJS.Timeout | null = null;
let cursorPollHzMs = 1000;

function tickCursor(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    win.webContents.send('cursor-pos', {
      cx: wx + ww / 2,
      cy: wy + wh / 2,
      mx: cursor.x,
      my: cursor.y,
    });
  } catch { /* screen API can fail during display change — non-fatal */ }
}

export function startCursorPoll(win: BrowserWindow): void {
  stopCursorPoll();
  cursorPollInterval = setInterval(() => tickCursor(win), cursorPollHzMs);
}

export function stopCursorPoll(): void {
  if (cursorPollInterval) { clearInterval(cursorPollInterval); cursorPollInterval = null; }
}

export function setCursorPollHz(win: BrowserWindow, hz: number): void {
  cursorPollHzMs = Math.max(33, Math.round(1000 / hz));
  if (cursorPollInterval) startCursorPoll(win); // restart with new rate
}

export function setClickThrough(win: BrowserWindow, enabled: boolean): void {
  // No-op on Windows — we don't use click-through anymore
}

export function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    // v0.20.0-alpha.10 — was 480×600 from the v0.12 era when the nav was
    // 140 px and the layout was a simple form list. The v2 redesign widened
    // the nav to 200 px and switched to card + row + value-chip rows, which
    // need ~520 px of content width to render without right-edge clipping.
    // 760×680 is the standard Settings size used by Linear/Vercel/Raycast
    // and gives generous room for the cards without going full-window.
    // 820 matches the settings stylesheet's intended width (the v2 redesign
    // grew the CSS body to 820 but left this at 760, clipping the right edge
    // of the cards). Body is now 100vw/100vh so any resize stays correct.
    width: 820,
    height: 680,
    icon: path.join(__dirname, '../../build/icon.ico'),
    resizable: true,
    minWidth: 640,
    minHeight: 560,
    minimizable: false,
    maximizable: false,
    title: 'ClippyAI Settings',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    settingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`);
  } else {
    settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  }

  settingsWindow.on('closed', () => { settingsWindow = null; });
  return settingsWindow;
}

export function createOnboardingWindow(): BrowserWindow {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return onboardingWindow;
  }

  const width = 480;
  const height = 700;
  // Centered, but never over Clippy's bottom-right corner: during "Try it"
  // the reply bubble (expanded window: 540×660, 10px inset) must stay
  // visible beside the onboarding window, not underneath it. On 1366-wide
  // screens that shifts the window ~120px left; wider screens stay centered.
  const wa = screen.getPrimaryDisplay().workArea;
  const centeredX = Math.round(wa.x + (wa.width - width) / 2);
  const clearOfClippyX = wa.x + wa.width - BUBBLE_EXPANDED_WIDTH - 10 - width - 12;
  const x = Math.max(wa.x, Math.min(centeredX, clearOfClippyX));
  const y = Math.max(wa.y, Math.round(wa.y + (wa.height - height) / 2));

  onboardingWindow = new BrowserWindow({
    // The body is width/height:100vw/vh, so it always fills whatever size we
    // set here — no CSS pixel value to keep in sync. Height 700 (was 620):
    // at 620 the usable per-step content area was only ~398px after the
    // header + footer, so content-heavy steps (app picker, API keys) showed
    // a sliver and READ as cropped even though they scrolled. 700 gives the
    // moderate steps room to fit outright; the rest scroll with a visible
    // affordance. Fits comfortably on any display ≥768px tall.
    width,
    height,
    x,
    y,
    icon: path.join(__dirname, '../../build/icon.ico'),
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    // Pure white onboarding window (user preference). Opaque white background;
    // frameless still gets macOS rounded corners via roundedCorners (default).
    backgroundColor: '#ffffff',
    title: 'Welcome to ClippyAI',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    onboardingWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/onboarding.html`);
  } else {
    onboardingWindow.loadFile(path.join(__dirname, '../renderer/onboarding.html'));
  }

  onboardingWindow.on('closed', () => { onboardingWindow = null; });
  return onboardingWindow;
}

/** Onboarding window if it is open (deep-link activation + tutorial signals). */
export function getOnboardingWindow(): BrowserWindow | null {
  return onboardingWindow && !onboardingWindow.isDestroyed() ? onboardingWindow : null;
}

let logWindow: BrowserWindow | null = null;

export function createLogWindow(): BrowserWindow {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus();
    return logWindow;
  }

  logWindow = new BrowserWindow({
    width: 700,
    height: 500,
    icon: path.join(__dirname, '../../build/icon.ico'),
    resizable: true,
    title: 'ClippyAI Logs',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    logWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/logs.html`);
  } else {
    logWindow.loadFile(path.join(__dirname, '../renderer/logs.html'));
  }

  logWindow.on('closed', () => { logWindow = null; });
  return logWindow;
}

// ── Writing-assist card (⌥G) ───────────────────────────────────────────
//
// A small frameless glass card that pops near the focused text field with
// Clippy's correction + an Apply button. Singleton: reused (and just
// repositioned) if it's still alive, so repeated ⌥G presses don't stack
// cards. Positioned just below-left of the anchor's bottom edge, clamped to
// the work area of the display the anchor sits on.
let writingCardWindow: BrowserWindow | null = null;

const WRITING_CARD_WIDTH = 380;
const WRITING_CARD_HEIGHT = 240;

export function createWritingCardWindow(
  anchor?: { x: number; y: number; width: number; height: number },
): BrowserWindow {
  // Reposition + reuse the live singleton rather than opening a second card.
  if (writingCardWindow && !writingCardWindow.isDestroyed()) {
    if (anchor) writingCardWindow.setBounds(positionForAnchor(anchor));
    writingCardWindow.showInactive();
    return writingCardWindow;
  }

  const initialBounds = anchor ? positionForAnchor(anchor) : undefined;

  writingCardWindow = new BrowserWindow({
    width: WRITING_CARD_WIDTH,
    height: WRITING_CARD_HEIGHT,
    x: initialBounds?.x,
    y: initialBounds?.y,
    icon: path.join(__dirname, '../../build/icon.ico'),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  writingCardWindow.setAlwaysOnTop(true, 'screen-saver');

  if (process.env.ELECTRON_RENDERER_URL) {
    writingCardWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/writing-card.html`);
  } else {
    writingCardWindow.loadFile(path.join(__dirname, '../renderer/writing-card.html'));
  }

  writingCardWindow.on('closed', () => { writingCardWindow = null; });
  return writingCardWindow;
}

/** Place the card just below-left of the anchor's bottom edge, clamped into
 *  the work area of the display the anchor sits on. */
function positionForAnchor(anchor: { x: number; y: number; width: number; height: number }): Rectangle {
  const display = screen.getDisplayMatching({
    x: Math.round(anchor.x),
    y: Math.round(anchor.y),
    width: Math.max(1, Math.round(anchor.width)),
    height: Math.max(1, Math.round(anchor.height)),
  });
  const desired: Rectangle = {
    x: Math.round(anchor.x),
    y: Math.round(anchor.y + anchor.height + 8),
    width: WRITING_CARD_WIDTH,
    height: WRITING_CARD_HEIGHT,
  };
  return clampRectToDisplay(desired, display);
}

// ── Writing badge (always-on watcher) ──────────────────────────────────
//
// A tiny always-on-top pill that the writing watcher pops at the bottom-right
// corner of the field you're typing in when Clippy spots fixable issues
// (Grammarly-style). Click it → the full ⌥G correction card (ipc.ts wires
// 'writing-badge:open' → triggerWritingAssist). Singleton: repositioned +
// re-counted rather than stacked.
let writingBadgeWindow: BrowserWindow | null = null;

const WRITING_BADGE_WIDTH = 132;
const WRITING_BADGE_HEIGHT = 40;

export function createWritingBadgeWindow(
  anchor: { x: number; y: number; width: number; height: number },
  count: number,
): BrowserWindow {
  const bounds = positionBadgeForAnchor(anchor);

  if (writingBadgeWindow && !writingBadgeWindow.isDestroyed()) {
    writingBadgeWindow.setBounds(bounds);
    sendBadgeCount(writingBadgeWindow, count);
    writingBadgeWindow.showInactive();
    return writingBadgeWindow;
  }

  writingBadgeWindow = new BrowserWindow({
    width: WRITING_BADGE_WIDTH,
    height: WRITING_BADGE_HEIGHT,
    x: bounds.x,
    y: bounds.y,
    icon: path.join(__dirname, '../../build/icon.ico'),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false, // never steal focus from the field being typed in
    hasShadow: false,
    backgroundColor: '#00000000',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  writingBadgeWindow.setAlwaysOnTop(true, 'screen-saver');

  const w = writingBadgeWindow;
  const onReady = () => { if (!w.isDestroyed()) sendBadgeCount(w, count); };
  if (process.env.ELECTRON_RENDERER_URL) {
    w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/writing-badge.html`);
  } else {
    w.loadFile(path.join(__dirname, '../renderer/writing-badge.html'));
  }
  w.webContents.once('did-finish-load', onReady);
  w.on('closed', () => { writingBadgeWindow = null; });
  return writingBadgeWindow;
}

export function hideWritingBadge(): void {
  if (writingBadgeWindow && !writingBadgeWindow.isDestroyed()) writingBadgeWindow.hide();
}

function sendBadgeCount(w: BrowserWindow, count: number): void {
  try { w.webContents.send('writing-badge:count', count); } catch { /* renderer not ready */ }
}

/** Bottom-right corner of the field, nudged just inside, clamped to display. */
function positionBadgeForAnchor(anchor: { x: number; y: number; width: number; height: number }): Rectangle {
  const display = screen.getDisplayMatching({
    x: Math.round(anchor.x),
    y: Math.round(anchor.y),
    width: Math.max(1, Math.round(anchor.width)),
    height: Math.max(1, Math.round(anchor.height)),
  });
  const desired: Rectangle = {
    x: Math.round(anchor.x + anchor.width - WRITING_BADGE_WIDTH - 6),
    y: Math.round(anchor.y + anchor.height - WRITING_BADGE_HEIGHT - 6),
    width: WRITING_BADGE_WIDTH,
    height: WRITING_BADGE_HEIGHT,
  };
  return clampRectToDisplay(desired, display);
}
