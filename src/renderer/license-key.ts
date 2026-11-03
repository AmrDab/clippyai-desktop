/**
 * License-key paste cleanup, shared by onboarding and Settings.
 *
 * Keys look like CLIPPY-XXXX-XXXX-XXXX and use only
 * ABCDEFGHJKMNPQRSTVWXYZ23456789 — no 0, 1, I, L, O or U, so look-alikes can
 * never be right. Telemetry showed a new user's pasted key rejected 4× in a
 * row; pastes from email arrive with en-dashes, hidden characters, line
 * breaks or a "License key:" label around them.
 */
const LOOKALIKES = /[01ILOU]/g;

/** Best effort: pull a CLIPPY key out of whatever was pasted. */
export function normalizeLicenseKey(raw: string): string {
  const s = String(raw || '')
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-') // typographic dashes
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')             // zero-width characters
    .replace(/\s+/g, '');                                     // spaces, tabs, line breaks
  const m = s.match(/CLIPPY-?([A-Z0-9]{4})-?([A-Z0-9]{4})-?([A-Z0-9]{4})/);
  return m ? `CLIPPY-${m[1]}-${m[2]}-${m[3]}` : s;
}

/** Characters in the key body that can never appear in a real key. */
export function keyLookalikes(key: string): string[] {
  const body = key.replace(/^CLIPPY-/, '').replace(/-/g, '');
  return [...new Set(body.match(LOOKALIKES) || [])];
}

export const KEY_FORMAT_HINT = 'Keys look like CLIPPY-XXXX-XXXX-XXXX.';

export function lookalikeMessage(chars: string[]): string {
  return `That key has ${chars.map((c) => `"${c}"`).join(', ')} in it, but Clippy keys never use 0, 1, I, L, O or U — ` +
    `it's probably a typo. Copy it straight from the email, or just click Activate in that email.`;
}

export const KEY_NOT_FOUND_MESSAGE =
  "We couldn't find that key. Easiest fix: open the email \u201cYour ClippyAI license key\u201d and click Activate. " +
  'Or copy the key from that email again (it starts with CLIPPY-).';
