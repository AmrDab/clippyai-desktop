/** "hey clippy" summons him to the chat and never toggles him to sleep (hotkey.ts). */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ globalShortcut: { register: () => true }, app: { focus: vi.fn() } }));
vi.mock('../src/main/brain', () => ({ Brain: class {}, brainSettingsStore: { get: () => undefined } }));
vi.mock('../src/main/writing-assist', () => ({ triggerWritingAssist: vi.fn() }));
vi.mock('../src/main/window', () => ({ getOnboardingWindow: () => null }));
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

import { summonToChat } from '../src/main/hotkey';
import type { Brain } from '../src/main/brain';
import type { BrowserWindow } from 'electron';

function setup(mode: 'awake' | 'sleep', visible: boolean) {
  const state = { mode, visible };
  const sends: string[] = [];
  const win = {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    show: vi.fn(() => { state.visible = true; }),
    hide: vi.fn(() => { state.visible = false; }),
    focus: vi.fn(),
    webContents: { send: (ch: string, arg?: unknown) => sends.push(arg === undefined ? ch : `${ch}:${arg}`) },
  };
  const brain = {
    getMode: () => state.mode,
    setMode: vi.fn((m: 'awake' | 'sleep') => { state.mode = m; }),
  };
  summonToChat(win as unknown as BrowserWindow, brain as unknown as Brain);
  return { state, sends, win, brain };
}

describe('summonToChat', () => {
  for (const mode of ['awake', 'sleep'] as const) {
    for (const visible of [true, false]) {
      it(`${mode}, ${visible ? 'visible' : 'hidden'}: ends awake, shown, focused, chat open`, () => {
        const { state, sends, win, brain } = setup(mode, visible);
        expect(brain.setMode).not.toHaveBeenCalledWith('sleep');
        expect(win.hide).not.toHaveBeenCalled();
        expect(state).toEqual({ mode: 'awake', visible: true });
        expect(win.focus).toHaveBeenCalled();
        expect(sends).not.toContain('mode-change:sleep');
        expect(sends[sends.length - 1]).toBe('summon-chat');
      });
    }
  }

  it('an already-awake Clippy is not re-woken (no second "I\'m awake" line)', () => {
    const { brain, sends } = setup('awake', true);
    expect(brain.setMode).not.toHaveBeenCalled();
    expect(sends).toEqual(['summon-chat']);
  });

  it('a sleeping Clippy is woken once, then the chat opens', () => {
    const { brain, sends } = setup('sleep', true);
    expect(brain.setMode).toHaveBeenCalledWith('awake');
    expect(sends).toEqual(['mode-change:awake', 'summon-chat']);
  });
});
