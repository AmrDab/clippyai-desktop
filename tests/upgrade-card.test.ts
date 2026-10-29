import { describe, it, expect } from 'vitest';
import { powerOffer, resetLine } from '../src/renderer/upgrade-card';

describe('powerOffer', () => {
  it('carries the $1 promo until Nov 10 PT, then the plain checkout', () => {
    const before = powerOffer(Date.parse('2026-11-10T20:00:00-08:00'));
    expect(before.label).toContain('$1');
    expect(before.url).toContain('prefilled_promo_code=CLIPPY1');
    const after = powerOffer(Date.parse('2026-11-11T00:00:01-08:00'));
    expect(after).toEqual({ label: 'Get Power', url: expect.not.stringContaining('promo') });
  });
});

describe('resetLine', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  it('names the reset day', () => {
    expect(resetLine('2026-11-01T12:00:00Z', now, 'en-US')).toBe('My free tokens come back on Nov 1.');
  });
  it('is empty for a missing, bad or past date', () => {
    expect(resetLine(undefined, now)).toBe('');
    expect(resetLine('nope', now)).toBe('');
    expect(resetLine('2026-10-01T00:00:00Z', now)).toBe('');
  });
});
