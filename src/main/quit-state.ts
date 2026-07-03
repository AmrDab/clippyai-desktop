/**
 * Shared "the app is genuinely quitting" flag.
 *
 * The main window's `close` handler hides instead of closing (always-on
 * assistant behaviour). Unconditionally, that blocks EVERY real quit path —
 * tray Quit, menu "Quit ClippyAI", Cmd+Q, and the auto-updater's
 * quitAndInstall()/app.quit() — so the only way out was Force Quit, and an
 * update would hang forever waiting for a quit that never happened (then fail
 * to reinitialize on the half-swapped app).
 *
 * Real quit paths flip this flag (app `before-quit`, plus explicitly in the
 * updater for belt-and-suspenders) and the window `close` handler honours it:
 * the window's red-X still hides to tray, but a genuine quit is allowed to
 * close + exit so Squirrel.Mac (or the NSIS installer on Windows) can swap the
 * app and relaunch.
 */
let quitting = false;

export function setQuitting(value = true): void {
  quitting = value;
}

export function isQuitting(): boolean {
  return quitting;
}
