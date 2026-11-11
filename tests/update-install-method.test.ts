import { describe, it, expect } from 'vitest';
import { installMethodFor } from '../src/main/update-install-method';

describe('installMethodFor', () => {
  it('installs silently first, falls back to Explorer after a failed attempt', () => {
    expect(installMethodFor(0)).toBe('silent');
    expect(installMethodFor(1)).toBe('explorer');
  });
});
