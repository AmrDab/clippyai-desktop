/**
 * v0.21 — what a single click on Clippy does. Pure so it can be unit-tested.
 *
 * In order: found (hide-and-seek) → stop the running task → close the open
 * text box (it recoils into him; a pending prompt counts as dismissed) →
 * engage (he was talking with nothing open) → open the chat.
 *
 * Update offers are NOT an input here on purpose: they are explicit bubble
 * buttons ("Restart to update" / "Download" / "Later"), never a hidden
 * "click Clippy" semantic. Before v0.21 a sticky pendingUpdate flag turned
 * any later click — long after the offer bubble was gone — into a download
 * or a quit-to-install, which is what "it's annoying when I press him and he
 * auto-updates" was about.
 */
export type ClickAction = 'game-found' | 'stop' | 'close' | 'engage' | 'chat';

export interface ClickState {
  activeGame: 'catch' | 'hide' | 'rps' | null;
  wasSpeaking: boolean;
  /** A task is running (main's working-start / working-stop). */
  working?: boolean;
  /** The text box, a reply or a prompt is showing (not the compact pill). */
  bubbleOpen?: boolean;
  /** Current update offer, if any. Ignored — documented input so tests can
   *  assert it never changes the outcome. */
  updateOffer?: 'download' | 'install' | 'manual' | null;
}

export function clickAction(s: ClickState): ClickAction {
  if (s.activeGame === 'hide') return 'game-found';
  // Owner, 2026-11-19: "if he is doing a task and he is pressed he stops";
  // "when clippy is pressed i want text box to recoil in".
  if (s.working) return 'stop';
  if (s.bubbleOpen) return 'close';
  if (s.wasSpeaking) return 'engage';
  return 'chat';
}
