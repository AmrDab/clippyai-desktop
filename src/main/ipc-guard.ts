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
