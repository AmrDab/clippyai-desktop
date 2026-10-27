/**
 * v0.21 — what a single click on Clippy does. Pure so it can be unit-tested.
 *
 * Update offers are NOT an input here on purpose: they are explicit bubble
 * buttons ("Restart to update" / "Download" / "Later"), never a hidden
 * "click Clippy" semantic. Before v0.21 a sticky pendingUpdate flag turned
 * any later click — long after the offer bubble was gone — into a download
 * or a quit-to-install, which is what "it's annoying when I press him and he
 * auto-updates" was about.
 */
export type ClickAction = 'game-found' | 'engage' | 'chat';

export interface ClickState {
  activeGame: 'catch' | 'hide' | 'rps' | null;
  wasSpeaking: boolean;
  /** Current update offer, if any. Ignored — documented input so tests can
   *  assert it never changes the outcome. */
  updateOffer?: 'download' | 'install' | 'manual' | null;
}

export function clickAction(s: ClickState): ClickAction {
  if (s.activeGame === 'hide') return 'game-found';
  if (s.wasSpeaking) return 'engage';
  return 'chat';
}
