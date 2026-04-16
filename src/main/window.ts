import { BrowserWindow, screen, ipcMain } from 'electron';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('Window');

let settingsWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;

// Small window sized to Clippy sprite — expands when bubble shows
const CLIPPY_WIDTH = 140;
const CLIPPY_HEIGHT = 110;
const EXPANDED_WIDTH = 220;
const EXPANDED_HEIGHT = 320;

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

  // Expand/collapse window when bubble shows/hides
  // Track state to prevent double-expand/collapse drift
  let isExpanded = false;

  ipcMain.on('expand-window', () => {
    if (win.isDestroyed() || isExpanded) return;
    isExpanded = true;
    const [x, y] = win.getPosition();
    win.setBounds({
      x: x - (EXPANDED_WIDTH - CLIPPY_WIDTH),
      y: Math.max(0, y - (EXPANDED_HEIGHT - CLIPPY_HEIGHT)),
      width: EXPANDED_WIDTH,
      height: EXPANDED_HEIGHT,
    });
  });

  ipcMain.on('collapse-window', () => {
    if (win.isDestroyed() || !isExpanded) return;
    isExpanded = false;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    win.setBounds({
      x: x + (w - CLIPPY_WIDTH),
      y: y + (h - CLIPPY_HEIGHT),
      width: CLIPPY_WIDTH,
      height: CLIPPY_HEIGHT,
    });
  });

  // Window drag movement — with bounds checking
  ipcMain.on('move-window', (_event, deltaX: number, deltaY: number) => {
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const display = screen.getPrimaryDisplay().workAreaSize;
    // Keep at least half the window on screen
    const newX = Math.max(-w / 2, Math.min(display.width - w / 2, x + deltaX));
    const newY = Math.max(0, Math.min(display.height - h / 2, y + deltaY));
    win.setPosition(Math.round(newX), Math.round(newY));
  });

  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });

  return win;
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
