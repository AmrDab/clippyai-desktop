/**
 * v0.22 — extras for the free-cap "Get Power" card (main.ts onUpgrade):
 * when the free tokens come back, and the button's offer.
 */

/** Label for the free-cap "Get Power" button. Checkout itself runs in main (POST /v1/checkout). */
export function powerOfferLabel(): string {
  return 'Get Power';
}

/** "They come back on Nov 1." — or '' when the date is missing or past. */
export function resetLine(resetDate: string | undefined, now: number, locale?: string): string {
  const t = resetDate ? Date.parse(resetDate) : NaN;
  if (!Number.isFinite(t) || t <= now) return '';
  const day = new Date(t).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `My free tokens come back on ${day}.`;
}
