// v0.23.1 — the free Power pass re-runs the last request. When Clippy says
// "that's a Power trick, want to unlock it?" the user often answers "yes"
// before tapping the pass button, so "yes" must not replace the real request.
const CONSENT = /^(yes|yeah|yep|yup|sure|ok|okay|k|please|yes please|do it|go|go ahead|let'?s go|unlock it|oui|si|sí|ja)$/;

export function isBareConsent(text: string): boolean {
  const t = text.toLowerCase().replace(/[^\p{L}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  return CONSENT.test(t);
}
