/** "hey clippy" wake phrase — the pure matcher behind it (input-triggers.ts). */
import { describe, it, expect } from 'vitest';
import { WakeMatcher } from '../src/main/input-triggers';

/** Type `text` one char per 100 ms from `t0`; true if any char fired. */
function type(m: WakeMatcher, text: string, t0 = 10_000): boolean {
  let fired = false;
  [...text].forEach((ch, i) => { if (m.pushChar(ch, t0 + i * 100)) fired = true; });
  return fired;
}

describe('WakeMatcher', () => {
  it('fires on "hey clippy" and "hi clippy", any case', () => {
    expect(type(new WakeMatcher(), 'hey clippy')).toBe(true);
    expect(type(new WakeMatcher(), 'hi clippy')).toBe(true);
    expect(type(new WakeMatcher(), 'HEY Clippy')).toBe(true);
    expect(type(new WakeMatcher(), 'Hi CLIPPY')).toBe(true);
  });

  it('fires on the no-space forms', () => {
    expect(type(new WakeMatcher(), 'heyclippy')).toBe(true);
    expect(type(new WakeMatcher(), 'hiclippy')).toBe(true);
  });

  it('fires after other words, with a space before "hey"', () => {
    expect(type(new WakeMatcher(), 'ok so hey clippy')).toBe(true);
  });

  it('needs a word boundary on the left: "they clippy" does not fire', () => {
    expect(type(new WakeMatcher(), 'they clippy')).toBe(false);
    expect(type(new WakeMatcher(), 'theyclippy')).toBe(false);
    expect(type(new WakeMatcher(), 'chi clippy')).toBe(false);
  });

  it('does not fire on a partial phrase or with two spaces', () => {
    expect(type(new WakeMatcher(), 'hey clipp')).toBe(false);
    expect(type(new WakeMatcher(), 'hey  clippy')).toBe(false);
  });

  it('backspace removes one char (special key or DEL char)', () => {
    const m = new WakeMatcher();
    type(m, 'hey clippx', 10_000);
    m.pushSpecial('backspace');
    expect(m.pushChar('y', 12_000)).toBe(true);

    const m2 = new WakeMatcher();
    type(m2, 'hey clippx', 10_000);
    m2.pushChar('\x7f', 12_000);
    expect(m2.pushChar('y', 12_100)).toBe(true);
  });

  it('about 4 s of idle time clears the buffer', () => {
    const m = new WakeMatcher();
    type(m, 'hey clipp', 10_000); // last char at 10_800
    expect(m.pushChar('y', 10_800 + 4_100)).toBe(false);

    const m2 = new WakeMatcher();
    type(m2, 'hey clipp', 10_000);
    expect(m2.pushChar('y', 10_800 + 3_900)).toBe(true);
  });

  it('keeps at most 12 chars, so a boundary is still seen after long typing', () => {
    // 12 = the longest phrase with its boundary space plus one.
    const m = new WakeMatcher();
    expect(type(m, 'abcdefghijklmnopqrstuvwxyz they clippy')).toBe(false);
    expect(type(new WakeMatcher(), 'abcdefghijklmnopqrstuvwxyz hey clippy')).toBe(true);
    expect((m as unknown as { buf: string }).buf.length).toBeLessThanOrEqual(12);
  });

  it('fires at most once every 2 s', () => {
    const m = new WakeMatcher();
    expect(type(m, 'hey clippy', 10_000)).toBe(true); // fires at 10_900
    expect(type(m, ' hey clippy', 11_000)).toBe(false); // would fire at 12_000
    expect(type(m, ' hey clippy', 13_000)).toBe(true); // 14_000: > 2 s after the first
  });

  it('arrow keys, Enter, Tab, Esc and reset() clear the buffer', () => {
    for (const key of ['left', 'right', 'up', 'down', 'return', 'tab', 'escape']) {
      const m = new WakeMatcher();
      type(m, 'hey clipp', 10_000);
      m.pushSpecial(key);
      expect(m.pushChar('y', 11_000)).toBe(false);
    }
    const m = new WakeMatcher();
    type(m, 'hey clipp', 10_000);
    m.reset();
    expect(m.pushChar('y', 11_000)).toBe(false);
  });

  it('ignores anything that is not a-z or space', () => {
    const m = new WakeMatcher();
    expect(type(m, 'hey cl1ippy')).toBe(true); // the digit is dropped, not a boundary
    expect(type(new WakeMatcher(), 'hey clippy!')).toBe(true);
  });
});
