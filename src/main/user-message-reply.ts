/**
 * user-message-reply.ts — a reply the user can see, whatever happened.
 *
 * The renderer ignores the value the 'user-message' IPC returns: the bubble
 * only shows what arrives as 'clippy-speak' (v0.11.29, to stop every reply
 * rendering twice). So a fallback that was only RETURNED ("Hmm, try again!",
 * "Something went wrong") never reached the bubble: the user saw Clippy think
 * and then nothing. Fallbacks are now spoken. Pure (no Electron) so it tests.
 */

export interface SpeakPayload { text: string; animate: string; tint?: string }

export const EMPTY_REPLY = 'Hmm, try again! 📎';
export const FAILED_REPLY = 'Something went wrong — try again! 📎';

/**
 * Run the brain for one user message. Its own replies are already spoken; an
 * empty result or a throw gets a spoken fallback here.
 */
export async function replyOrSpeak(
  run: () => Promise<string>,
  speak: (p: SpeakPayload) => void,
  onError: (err: unknown) => void = () => {},
): Promise<string> {
  try {
    const response = await run();
    if (response) return response;
    speak({ text: EMPTY_REPLY, animate: 'Alert' });
    return EMPTY_REPLY;
  } catch (err) {
    onError(err);
    speak({ text: FAILED_REPLY, animate: 'Alert', tint: 'error' });
    return FAILED_REPLY;
  }
}
