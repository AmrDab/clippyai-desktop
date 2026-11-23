/**
 * ipc-guard.ts — which window may call an IPC channel.
 *
 * Every renderer shares one preload, so any window's page could call any
 * channel. The channels that start a task (user-message) or change what
 * Clippy may do without asking (guardrails:*, byok:*) are tied to the one
 * window that owns them (0.24.12 audit #7).
 */

interface WindowLike {
  webContents: unknown;
  isDestroyed?: () => boolean;
}

/** True when the IPC event was sent by `win`'s own page. */
export function senderIsWindow(event: { sender: unknown }, win: WindowLike | null | undefined): boolean {
  if (!win || win.isDestroyed?.()) return false;
  return event.sender === win.webContents;
}

// Sites the open-external-url channel may open in the user's browser.
const EXTERNAL_HOSTS = new Set(['clippyai.app', 'api.clippyai.app', 'github.com']);

/**
 * The open-external-url channel: a mailto: link (the user's mail app), or an
 * https:// page on one of our hosts. The scheme is checked too: a hostname
 * alone let `http:` and any other scheme with that host through to
 * shell.openExternal (2026-11 scan).
 */
export function isAllowedExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === 'mailto:') return true;
  return u.protocol === 'https:' && !u.username && !u.password && EXTERNAL_HOSTS.has(u.hostname);
}
