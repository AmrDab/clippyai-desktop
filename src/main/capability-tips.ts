/**
 * Capability-gap tip registry.
 *
 * When Clippy completes a task using a fallback path (debug-launched browser
 * instead of mcp-chrome, basic-tier OCR instead of UIA, etc.), we offer the
 * user a one-time tip to install the missing capability. The tip is shown
 * ONCE per user lifetime — once they see it, the registry persists a marker
 * to ~/.clippyai/capability-tips.json and never offers it again.
 *
 * Structural by design — the brain.ts hook in handleUserMessage looks up
 * tips by id; adding a new "you don't have Outlook installed, use web?"
 * suggestion is a single entry in CAPABILITY_TIPS below, not a new code
 * path inside brain.ts. New tools shipping new capability-gap scenarios
 * register their tip here and the wiring is done.
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createLogger } from './logger';

const log = createLogger('CapabilityTips');

interface CapabilityTip {
  /** Stable id — used as the dismissal marker key. Never rename. */
  id: string;
  /** Bubble copy. Keep it short — one sentence + the URL. */
  message: string;
  /** Where the user goes when they tap the link in the bubble. */
  url: string;
}

const CAPABILITY_TIPS: Record<string, CapabilityTip> = {
  'browser-extension': {
    id: 'browser-extension',
    message:
      "Tip: I just used a temporary browser window for that. Install the Clippy browser extension at clippyai.app/extension — it lets me use YOUR signed-in Chrome (with cookies, extensions, and history) so browser tasks are way faster.",
    url: 'https://clippyai.app/extension',
  },
};

function statePath(): string {
  return path.join(app.getPath('userData'), 'capability-tips.json');
}

function loadShown(): Record<string, string> {
  try {
    const p = statePath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveShown(state: Record<string, string>): void {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log.warn('saveShown failed (non-fatal)', { error: (err as Error).message });
  }
}

/**
 * Returns the tip message to append IF the tip should be shown this turn,
 * or null otherwise. Side-effect: marks the tip as shown so subsequent
 * calls return null.
 */
export function maybeOfferCapabilityTip(id: string): string | null {
  const tip = CAPABILITY_TIPS[id];
  if (!tip) return null;
  const shown = loadShown();
  if (shown[id]) return null;
  shown[id] = new Date().toISOString();
  saveShown(shown);
  log.info('Capability tip offered', { id });
  return tip.message;
}

/**
 * Force-reset a tip so it shows again next time. For debugging / Settings →
 * "Reset all capability tips."
 */
export function resetCapabilityTip(id?: string): void {
  if (id) {
    const shown = loadShown();
    delete shown[id];
    saveShown(shown);
  } else {
    try { fs.unlinkSync(statePath()); } catch { /* fine if not present */ }
  }
}
