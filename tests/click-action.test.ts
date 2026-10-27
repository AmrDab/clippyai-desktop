import { describe, it, expect } from 'vitest';
import { clickAction } from '../src/renderer/click-action';

describe('clickAction — a click on Clippy never installs or downloads an update', () => {
  it('opens the chat on a plain click', () => {
    expect(clickAction({ activeGame: null, wasSpeaking: false })).toBe('chat');
  });
  it('yields to the user when interrupted mid-speech', () => {
    expect(clickAction({ activeGame: null, wasSpeaking: true })).toBe('engage');
  });
  it('counts as "found" during hide-and-seek', () => {
    expect(clickAction({ activeGame: 'hide', wasSpeaking: true })).toBe('game-found');
  });
  it('ignores a pending update offer at every stage', () => {
    for (const updateOffer of ['download', 'install', 'manual'] as const) {
      expect(clickAction({ activeGame: null, wasSpeaking: false, updateOffer })).toBe('chat');
      expect(clickAction({ activeGame: null, wasSpeaking: true, updateOffer })).toBe('engage');
      expect(clickAction({ activeGame: 'hide', wasSpeaking: false, updateOffer })).toBe('game-found');
    }
  });
});
