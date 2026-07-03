/**
 * history-budget.ts — pure, dependency-free trimming for the brain's
 * conversation history.
 *
 * Why this module is isolated: the brain used to cap history at a flat 16
 * messages (MAX_HISTORY), which gave Clippy only ~8 turns of memory no matter
 * how short they were, and the backend model's ~128K-token window sat mostly
 * unused. We now trim by a TOKEN BUDGET instead. The logic lives here (no
 * Electron imports) so it can be unit-tested against synthetic histories with
 * no app, mirroring the dep-free-for-testability pattern of send-verify.ts.
 *
 * Test: scripts/test-history-budget.js
 */

/** Minimal structural shape of a conversation message — a subset of brain.ts's
 *  `Content`. Declared locally so this module pulls in no runtime deps. */
export interface BudgetContent {
  role: string;
  parts?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Rough token estimate for one message: ~4 chars/token plus a small
 * per-message overhead. Deliberately a heuristic — good enough for budget
 * trimming without bundling a real tokenizer. Counts text, and the serialized
 * size of any function-call / function-response parts (base64 image parts
 * shouldn't appear in collapsed history and are ignored).
 */
export function estimateContentTokens(c: BudgetContent): number {
  let chars = 0;
  for (const p of c.parts ?? []) {
    const text = (p as { text?: unknown }).text;
    if (typeof text === 'string') {
      chars += text.length;
    } else if ('functionCall' in p) {
      chars += JSON.stringify((p as { functionCall: unknown }).functionCall).length;
    } else if ('functionResponse' in p) {
      chars += JSON.stringify((p as { functionResponse: unknown }).functionResponse).length;
    }
  }
  return Math.ceil(chars / 4) + 4;
}

/**
 * Drop the oldest messages (front of the array) until the history fits BOTH
 * the token budget and the message ceiling. Mutates and returns the same
 * array. Always keeps at least the most recent message — even a single
 * message larger than the budget is retained rather than leaving Clippy with
 * an empty context.
 */
export function trimToBudget<T extends BudgetContent>(
  history: T[],
  tokenBudget: number,
  maxMessages: number,
): T[] {
  let total = 0;
  for (const c of history) total += estimateContentTokens(c);
  while (
    history.length > 1
    && (total > tokenBudget || history.length > maxMessages)
  ) {
    const removed = history.shift();
    if (removed) total -= estimateContentTokens(removed);
  }
  return history;
}
