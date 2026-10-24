import { describe, it, expect } from 'vitest';
import {
  fromPersisted, visibleHistory, composerHeight,
  COMPOSER_LINE_PX, COMPOSER_PAD_Y_PX, COMPOSER_MAX_LINES, HISTORY_LIMIT,
} from '../src/renderer/chat-history';

describe('fromPersisted — main conversation-history.json → panel messages', () => {
  it('maps user/model rows and drops blanks + junk', () => {
    const rows = [
      { role: 'user', text: 'hi' },
      { role: 'model', text: 'Hello! 📎' },
      { role: 'model', text: '   ' },
      { role: 'tool', text: 'ignored' },
      null, 42, { role: 'user' },
    ];
    expect(fromPersisted(rows)).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'clippy', text: 'Hello! 📎' },
    ]);
  });
  it('returns [] for non-arrays', () => {
    expect(fromPersisted(undefined)).toEqual([]);
    expect(fromPersisted('nope')).toEqual([]);
  });
});

describe('visibleHistory — which entries the panel shows', () => {
  const msg = (role: 'user' | 'clippy' | 'system', text: string) => ({ role, text });
  it('keeps only user + clippy turns with text, oldest first', () => {
    const out = visibleHistory([
      msg('system', 'tool chatter'), msg('user', 'a'), msg('clippy', ''), msg('clippy', 'b'),
    ]);
    expect(out.map((m) => m.text)).toEqual(['a', 'b']);
  });
  it('shows the last N (default 20), newest at the end', () => {
    const many = Array.from({ length: 50 }, (_, i) => msg(i % 2 ? 'clippy' : 'user', `m${i}`));
    const out = visibleHistory(many);
    expect(out).toHaveLength(HISTORY_LIMIT);
    expect(out[0].text).toBe('m30');
    expect(out[out.length - 1].text).toBe('m49');
    expect(visibleHistory(many, 3).map((m) => m.text)).toEqual(['m47', 'm48', 'm49']);
  });
});

describe('composerHeight — textarea auto-grow clamp', () => {
  const one = COMPOSER_LINE_PX + COMPOSER_PAD_Y_PX;
  const max = COMPOSER_LINE_PX * COMPOSER_MAX_LINES + COMPOSER_PAD_Y_PX;
  it('never shrinks below one line', () => {
    expect(composerHeight(0)).toEqual({ height: one, scrolls: false });
  });
  it('grows with content up to four lines', () => {
    const two = one + COMPOSER_LINE_PX;
    expect(composerHeight(two)).toEqual({ height: two, scrolls: false });
    expect(composerHeight(max)).toEqual({ height: max, scrolls: false });
  });
  it('clamps past four lines and switches to scrolling', () => {
    expect(composerHeight(max + COMPOSER_LINE_PX * 3)).toEqual({ height: max, scrolls: true });
  });
});
