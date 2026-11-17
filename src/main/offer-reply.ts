/**
 * A typed "yes" right after Clippy's Power offer means "unlock it", the same as
 * tapping the card. Without this the reply went to the model, which (on Free or
 * in basic mode) has no way to act on it and answered "Yes to what, though?"
 * (Mac report abd98d96, 2026-11-17). en/pt/es/fr.
 */
const AFFIRM_RE = /^\s*(?:y|ya|yes+|yeah|yep|yup|sure|ok(?:ay)?|k|please|do it|go ahead|go for it|unlock(?: it)?|let'?s do it|let'?s go|sim|claro|pode|s[ií]|vale|dale|oui|ouais|d'accord|vas-y)(?:[\s,]+(?:please|thanks|thank you|do it|go ahead|unlock it|por favor|s'il te pla[iî]t))*\s*[.!👍]*\s*$/i;

/** How long after the offer a bare "yes" still answers it. */
export const OFFER_REPLY_WINDOW_MS = 10 * 60_000;

export function isAffirmative(text: string): boolean {
  return text.length <= 40 && AFFIRM_RE.test(text);
}

export type OfferReply = 'use_pass' | 'open_upgrade' | null;

export function offerReply(
  offer: { at: number; passAvailable: boolean } | null,
  text: string,
  now: number,
): OfferReply {
  if (!offer || now - offer.at > OFFER_REPLY_WINDOW_MS || !isAffirmative(text)) return null;
  return offer.passAvailable ? 'use_pass' : 'open_upgrade';
}
