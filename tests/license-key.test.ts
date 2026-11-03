import { describe, it, expect } from 'vitest';
import { normalizeLicenseKey, keyLookalikes } from '../src/renderer/license-key';

describe('normalizeLicenseKey — pastes from email', () => {
  const KEY = 'CLIPPY-AB2C-DE3F-GH4J';
  it('passes a clean key through', () => expect(normalizeLicenseKey(KEY)).toBe(KEY));
  it('fixes case and surrounding spaces / line breaks', () =>
    expect(normalizeLicenseKey('  clippy-ab2c-de3f-gh4j\r\n')).toBe(KEY));
  it('turns typographic dashes into hyphens', () =>
    expect(normalizeLicenseKey('CLIPPY–AB2C—DE3F−GH4J')).toBe(KEY));
  it('drops zero-width characters', () =>
    expect(normalizeLicenseKey('CLIPPY-​AB2C-DE3F﻿-GH4J')).toBe(KEY));
  it('pulls the key out of a pasted label or sentence', () =>
    expect(normalizeLicenseKey('Your license key: CLIPPY-AB2C-DE3F-GH4J (keep it safe)')).toBe(KEY));
  it('accepts a key typed without dashes or with spaces', () => {
    expect(normalizeLicenseKey('CLIPPYAB2CDE3FGH4J')).toBe(KEY);
    expect(normalizeLicenseKey('CLIPPY AB2C DE3F GH4J')).toBe(KEY);
  });
  it('returns the cleaned text when no key is present', () =>
    expect(normalizeLicenseKey(' hello ')).toBe('HELLO'));
});

describe('keyLookalikes', () => {
  it('flags characters real keys never contain', () =>
    expect(keyLookalikes('CLIPPY-AB0C-DE1F-GHOJ').sort()).toEqual(['0', '1', 'O']));
  it('ignores the CLIPPY prefix (which contains I and L)', () =>
    expect(keyLookalikes('CLIPPY-AB2C-DE3F-GH4J')).toEqual([]));
});
