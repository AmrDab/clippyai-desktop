import { describe, it, expect } from 'vitest';
import { isBareConsent } from '../src/main/pass-request';

describe('isBareConsent', () => {
  it('matches a plain yes to the Power offer', () => {
    for (const t of ['yes', 'Yes!', 'ok', 'okay 👍', 'sure', 'yes please', 'do it', 'Go ahead.', "let's go", 'oui']) {
      expect(isBareConsent(t)).toBe(true);
    }
  });

  it('does not match a real request', () => {
    for (const t of ['draw for me', 'yes, draw a cat', 'open paint', 'ok now make it blue', '']) {
      expect(isBareConsent(t)).toBe(false);
    }
  });
});
