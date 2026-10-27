// v0.21 — pure helpers for the bubble's conversation panel + composer.
// No DOM: unit-tested in vitest (node env).

export interface ChatMessage {
  role: 'user' | 'clippy' | 'system';
  text: string;
  /** Session messages carry a time; entries restored from disk don't. */
  time?: Date;
}

/** One entry of main's persisted conversation (brain.ts getConversation()). */
export interface PersistedTurn {
  role: 'user' | 'model';
  text: string;
}

/** Default number of turns the panel shows. */
export const HISTORY_LIMIT = 20;

/** Map main's collapsed history (user text + Clippy's spoken replies only —
 *  tool calls are never persisted) into panel messages. Blank or
 *  malformed rows are dropped. */
export function fromPersisted(rows: unknown): ChatMessage[] {
  if (!Array.isArray(rows)) return [];
  const out: ChatMessage[] = [];
  for (const r of rows as Partial<PersistedTurn>[]) {
    if (!r || typeof r.text !== 'string' || !r.text.trim()) continue;
    if (r.role === 'user') out.push({ role: 'user', text: r.text });
    else if (r.role === 'model') out.push({ role: 'clippy', text: r.text });
  }
  return out;
}

/** The slice the panel renders: user + Clippy turns only (no system rows,
 *  no empty text), last `limit` of them, oldest first. */
export function visibleHistory(messages: ChatMessage[], limit = HISTORY_LIMIT): ChatMessage[] {
  const shown = messages.filter((m) => (m.role === 'user' || m.role === 'clippy') && m.text.trim() !== '');
  return limit > 0 ? shown.slice(-limit) : shown;
}

/** Shell-style prompt recall for ↑/↓ in the composer. `idx` is the current
 *  position in `sent` (null = not recalling). Up from null starts at the
 *  newest; down past the newest returns to an empty draft (idx null). */
export function recallStep(
  sent: string[], idx: number | null, dir: 'up' | 'down',
): { idx: number | null; text: string } {
  if (sent.length === 0) return { idx: null, text: '' };
  if (dir === 'up') {
    const next = idx === null ? sent.length - 1 : Math.max(0, idx - 1);
    return { idx: next, text: sent[next] };
  }
  if (idx === null || idx >= sent.length - 1) return { idx: null, text: '' };
  return { idx: idx + 1, text: sent[idx + 1] };
}

// Composer auto-grow. The textarea's CSS sets line-height + vertical
// padding; these constants must match style.css `#bubble-input`.
export const COMPOSER_LINE_PX = 20;
export const COMPOSER_PAD_Y_PX = 16; // 8px top + 8px bottom
export const COMPOSER_MAX_LINES = 4;

/** Height to give the textarea for its content (`scrollHeight`), clamped to
 *  one..COMPOSER_MAX_LINES lines. `scrolls` is true when content exceeds
 *  the clamp and the field should scroll instead of growing. */
export function composerHeight(scrollHeight: number): { height: number; scrolls: boolean } {
  const min = COMPOSER_LINE_PX + COMPOSER_PAD_Y_PX;
  const max = COMPOSER_LINE_PX * COMPOSER_MAX_LINES + COMPOSER_PAD_Y_PX;
  const height = Math.min(Math.max(scrollHeight, min), max);
  return { height, scrolls: scrollHeight > max };
}
