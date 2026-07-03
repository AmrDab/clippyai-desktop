/**
 * send-verify.ts — pure, dependency-free decision core for confirming a
 * keystroke-driven Messages send WITHOUT a screenshot or Full Disk Access.
 *
 * Why this module is isolated: the model drives Messages by keystroke
 * (open_url(sms:…?body=…) → key_press(Return)) because there's no dedicated,
 * confirmable send tool on the client — that would need an API-side schema.
 * key_press therefore lands in the brain's NEVER_CONFIRMS_SUCCESS set, so the
 * hallucination guard can never call the send "done". chat.db could confirm it
 * but needs Full Disk Access most users haven't granted. The accessibility
 * tree is the third path — and it's the one with zero new permissions.
 *
 * This file holds ONLY the verdict logic (no Electron / bridge imports) so it
 * can be unit-tested against synthetic trees with no UI and no side effects.
 * tools.ts does the bridge I/O and delegates the decision here. Mirrors the
 * dep-free-for-testability pattern used by tool-meta.ts.
 *
 * Test: scripts/test-send-verify.js
 */

export type SendVerdict = 'confirmed' | 'unconfirmed' | 'not_sent' | 'unknown';

/**
 * Minimal structural shape of an accessibility node — a subset of
 * mac-bridge-native's AxElement. Declared locally so this module pulls in no
 * runtime dependencies.
 */
export interface AxNodeLike {
  role: string;
  title?: string | null;
  value?: string | null;
  focused?: boolean;
  children?: ReadonlyArray<AxNodeLike>;
}

// Editable roles a Messages surface can use. Validated against macOS Tahoe
// (Darwin 25): the COMPOSE input is an AXTextField, while TRANSCRIPT BUBBLES
// render as (non-focused) AXTextAreas — the opposite of the naive assumption.
// So role alone can't separate draft from bubble; `focused` is the reliable
// discriminator (see classifyMessagesTree). Kept for the role fallback only.
export const MESSAGES_EDITABLE_ROLES: ReadonlySet<string> = new Set([
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
]);

/**
 * Decide whether a Messages send went through, given the app's accessibility
 * windows and the (already lowercased + trimmed) message body.
 *
 * Real AX structure (macOS Tahoe, verified live):
 *   • The compose input is the FOCUSED editable node (an AXTextField pinned to
 *     the bottom of the window). The sms: URL pre-fills it with the body.
 *   • Sent/received messages are non-focused AXTextAreas in the transcript —
 *     NOT AXStaticText, and the SAME broad role family as the compose box. So
 *     `focused` — not role — is what separates "draft still in the box" from
 *     "text made it into the conversation".
 *
 * Verdict model:
 *   • body in the FOCUSED editable node (or, if focus is unknown, an
 *     AXTextField) → 'not_sent' — Return didn't fire / wrong app focused; the
 *     draft is stuck in the box.
 *   • body in a non-focused transcript node → 'confirmed' — it became a bubble.
 *   • body nowhere, compose clear → 'unconfirmed' — strong evidence (the draft
 *     is gone) but not proof; the bubble may sit below the read depth.
 *   • no windows / empty needle → 'unknown'.
 *
 * Conservative by construction: a stuck draft can NEVER read as 'confirmed', so
 * an actual failure is never upgraded to success. If the same body sits in BOTH
 * the compose box and a bubble (resend of identical text), 'not_sent' wins —
 * better to under-claim and retry than to lie about a send.
 */
export function classifyMessagesTree(
  windows: ReadonlyArray<{ elements?: ReadonlyArray<AxNodeLike> }> | undefined,
  needle: string,
): SendVerdict {
  if (!needle) return 'unknown';
  if (!windows || windows.length === 0) return 'unknown';

  let draftHoldsBody = false; // body sits in the compose box (un-sent)
  let bubbleHoldsBody = false; // body became a transcript bubble (sent)

  const walk = (el: AxNodeLike): void => {
    const hay = `${el.title ?? ''} ${el.value ?? ''}`.toLowerCase();
    if (hay.includes(needle)) {
      const editable = MESSAGES_EDITABLE_ROLES.has(el.role);
      // The compose box is the focused editable node. When focus state is
      // unavailable, fall back to role: an AXTextField is the input, never a
      // bubble (bubbles are AXTextAreas).
      if ((editable && el.focused === true) || el.role === 'AXTextField') {
        draftHoldsBody = true;
      } else {
        bubbleHoldsBody = true;
      }
    }
    el.children?.forEach(walk);
  };
  for (const w of windows) (w.elements ?? []).forEach(walk);

  if (draftHoldsBody) return 'not_sent';
  if (bubbleHoldsBody) return 'confirmed';
  return 'unconfirmed';
}
