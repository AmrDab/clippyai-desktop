import { describe, it, expect } from 'vitest';
import { powerOfferLabel, resetLine } from '../src/renderer/upgrade-card';

describe('powerOfferLabel', () => {
  it('is a plain Get Power button; the checkout link comes from the server', () => {
    expect(powerOfferLabel()).toBe('Get Power');
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
