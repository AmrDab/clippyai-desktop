/**
 * v0.22 — extras for the free-cap "Get Power" card (main.ts onUpgrade):
 * when the free tokens come back, and the button's offer.
 */
const STRIPE_POWER_URL = 'https://buy.stripe.com/8x2bJ06jXfC65XDe2Oe3e03'; // $19.99/mo
// Campaign power-1usd-oct: promo CLIPPY1 ($1 first month) ends Nov 10 23:59 PT.
const PROMO_URL = 'https://buy.stripe.com/cNieVcgYB3TobhX3oae3e06?prefilled_promo_code=CLIPPY1';
const PROMO_ENDS = Date.parse('2026-11-11T07:59:59Z');

export function powerOffer(now: number): { label: string; url: string } {
  return now < PROMO_ENDS
    ? { label: 'Get Power — $1 first month', url: PROMO_URL }
    : { label: 'Get Power', url: STRIPE_POWER_URL };
}

/** "They come back on Nov 1." — or '' when the date is missing or past. */
export function resetLine(resetDate: string | undefined, now: number, locale?: string): string {
  const t = resetDate ? Date.parse(resetDate) : NaN;
  if (!Number.isFinite(t) || t <= now) return '';
  const day = new Date(t).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `My free tokens come back on ${day}.`;
}
