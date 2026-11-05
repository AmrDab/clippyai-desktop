import { describe, it, expect } from 'vitest';
import { summonTransition } from '../src/main/hotkey-defs';

describe('summonTransition — Ctrl+Shift+C (plan §1.5)', () => {
  it('hidden + awake (closed via Alt+F4 before v0.23) → show and stay awake, one press', () => {
    expect(summonTransition('awake', false)).toEqual({ mode: 'awake', show: true });
  });

  it('hidden + asleep (closed via Alt+F4 in v0.23) → show and wake, one press', () => {
    expect(summonTransition('sleep', false)).toEqual({ mode: 'awake', show: true });
  });

  it('visible + awake → sleep and hide', () => {
    expect(summonTransition('awake', true)).toEqual({ mode: 'sleep', show: false });
  });

  it('visible + asleep → wake, keep visible', () => {
    expect(summonTransition('sleep', true)).toEqual({ mode: 'awake', show: true });
  });
});
