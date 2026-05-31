import { BrowserWindow, screen, ipcMain, Rectangle, Display } from 'electron';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('Window');

let settingsWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;

// Small window sized to Clippy sprite — expands when bubble shows
const CLIPPY_WIDTH = 140;
const CLIPPY_HEIGHT = 110;
const EXPANDED_WIDTH = 320;
const EXPANDED_HEIGHT = 380;

// ── anchor-aware bubble geometry (ported from macOS v0.20.0-alpha.14) ──
//
// Pre-fix `expand-window` always grew up + left (`x - (EXPANDED_WIDTH -
// CLIPPY_WIDTH)`), assuming Clippy lives in the screen's bottom-right
// corner. But the window is freely draggable, so on the left/top edge or
// a second monitor the expanded bubble fell off-screen, the y=0 clamp
// pinned the top edge while the bubble CSS still drew below, and collapse
// (recomputed from live size) drifted whenever a setBounds had been
// clamped — so Clippy "walked" across the screen over repeated show/hide.
//
// New model — Clippy's sprite is pinned to the window's BOTTOM-RIGHT
// corner (see #bubble / #clippy in style.css). That sprite corner is the
// invariant we preserve across the resize:
//
//   anchor = (x + w, y + h)   // bottom-right of the window = Clippy
//
// On expand we keep `anchor` fixed and grow the bubble AWAY from it
// (up + left), then clamp the resulting rect into the WORK AREA of the
// display the window actually sits on (nearest-display, DPI-aware — not
// the primary display). If the grown rect can't fit above the anchor
// (Clippy near the top edge), we flip it to grow downward and tell the
// renderer so the tail flips too (.bubble--below). The exact pre-expand
// origin is stored so collapse restores it verbatim rather than
// re-deriving it from a possibly-clamped size.

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

/** The display the window's center currently sits on. Uses the nearest
 *  display (multi-monitor + per-monitor DPI safe) rather than the primary. */
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

  // Expand/collapse window when bubble shows/hides.
  // Track state to prevent double-expand/collapse drift.
  let isExpanded = false;
  // Exact pre-expand origin (top-left of the collapsed sprite window).
  // Captured on expand and restored verbatim on collapse so a clamped
  // intermediate setBounds can't make Clippy drift across the screen over
  // repeated show/hide.
  let collapsedOrigin: { x: number; y: number } | null = null;
  // Which side the bubble body last rendered on, so we only message the
  // renderer when it actually flips.
  let currentSide: BubbleSide = 'above';

  // Tell the renderer which side the bubble body sits on so it can flip the
  // tail (.bubble--below). Only emits on an actual change.
  function setBubbleSide(side: BubbleSide): void {
    if (side === currentSide) return;
    currentSide = side;
    if (!win.isDestroyed()) win.webContents.send('bubble-side', side);
  }

  ipcMain.on('expand-window', () => {
    if (win.isDestroyed() || isExpanded) return;
    isExpanded = true;
    const [x, y] = win.getPosition();
    const [oldW, oldH] = win.getSize();
    const display = displayForWindow(win);

    // Capture the pre-expand origin so collapse can restore it verbatim.
    collapsedOrigin = { x, y };

    // Preserve Clippy's sprite corner = the window's bottom-right, and grow
    // the bubble away from it (up + left) by default.
    const anchorRight = x + oldW;
    const anchorBottom = y + oldH;
    const newX = anchorRight - EXPANDED_WIDTH;
    let newY = anchorBottom - EXPANDED_HEIGHT; // grow upward by default
    let side: BubbleSide = 'above';

    // If growing upward would clip the top of the work area, flip and grow
    // downward from Clippy's top edge instead (tail points up).
    const wa = display.workArea;
    if (newY < wa.y && anchorBottom - oldH + EXPANDED_HEIGHT <= wa.y + wa.height) {
      newY = anchorBottom - oldH; // keep Clippy's top edge, extend below
      side = 'below';
    }

    const rect = clampRectToDisplay({ x: newX, y: newY, width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT }, display);
    log.debug('Bubble window expand', { from: [x, y, oldW, oldH], side, rect });
    win.setBounds(rect);
    setBubbleSide(side);
  });

  ipcMain.on('collapse-window', () => {
    if (win.isDestroyed() || !isExpanded) return;
    isExpanded = false;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const display = displayForWindow(win);
    // Restore the stored pre-expand origin verbatim. Fall back to the
    // bottom-right-preserving math only if we somehow never captured one.
    // Clamp so a display change while expanded can't leave the sprite
    // off-screen.
    const origin = collapsedOrigin ?? { x: x + (w - CLIPPY_WIDTH), y: y + (h - CLIPPY_HEIGHT) };
    const rect = clampRectToDisplay({ x: origin.x, y: origin.y, width: CLIPPY_WIDTH, height: CLIPPY_HEIGHT }, display);
    log.debug('Bubble window collapse', { restored: origin, rect });
    win.setBounds(rect);
    collapsedOrigin = null;
    setBubbleSide('above'); // collapsed sprite has no tail; reset for next open
  });

  // Window drag movement — with bounds checking
  ipcMain.on('move-window', (_event, deltaX: number, deltaY: number) => {
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    // Clamp against the display the window is on, not the primary display,
    // so drags across a multi-monitor setup don't get yanked back. Keep at
    // least half the window on screen horizontally and never let the top
    // edge leave the work area.
    const target = { x: x + deltaX, y: y + deltaY };
    const display = screen.getDisplayNearestPoint({ x: Math.round(target.x + w / 2), y: Math.round(target.y + h / 2) });
    const wa = display.workArea;
    const newX = Math.max(wa.x - w / 2, Math.min(wa.x + wa.width - w / 2, target.x));
    const newY = Math.max(wa.y, Math.min(wa.y + wa.height - h / 2, target.y));
    win.setPosition(Math.round(newX), Math.round(newY));
    // The user is repositioning the sprite — any stored collapse origin is
    // now stale, so drop it (only meaningful while collapsed).
    if (!isExpanded) collapsedOrigin = null;
  });

  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });

  return win;
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
    width: 480,
    height: 600,
    icon: path.join(__dirname, '../../build/icon.ico'),
    resizable: false,
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

  onboardingWindow = new BrowserWindow({
    width: 400,
    height: 500,
    icon: path.join(__dirname, '../../build/icon.ico'),
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
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
