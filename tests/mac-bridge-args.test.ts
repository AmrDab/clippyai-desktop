import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { focusedArgs } from '../src/main/mac-bridge-native';

describe('focused-element bridge args', () => {
  it('without a pid the subcommand is unchanged (system-wide focus)', () => {
    expect(focusedArgs('a11y-focused')).toEqual(['a11y-focused']);
    expect(focusedArgs('a11y-focused-set-value', undefined, ['--value', 'x'])).toEqual(['a11y-focused-set-value', '--value', 'x']);
  });
  it('with a pid it appends --pid', () => {
    expect(focusedArgs('a11y-selected-text', 42)).toEqual(['a11y-selected-text', '--pid', '42']);
    expect(focusedArgs('a11y-focused-set-value', 7, ['--value', 'hi'])).toEqual(['a11y-focused-set-value', '--value', 'hi', '--pid', '7']);
  });
});
