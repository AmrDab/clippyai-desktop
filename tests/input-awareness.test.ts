import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TriggerMatcher, RollingBuffer, redactSecrets } from '../src/main/input-triggers';
import { summarizeTyping } from '../src/main/input-summarizer';

// Ported from clippyai-macos#21's smoke checks, plus the opt-in guarantee
// added in the converge: the keyboard monitor is OFF unless the user enables it.

describe('input-triggers', () => {
  it('"hello clippy" fires summon (case-insensitive); a partial phrase does not', () => {
    const m = new TriggerMatcher();
    let summon = null;
    for (const ch of 'oh HELLO Clippy') summon = m.pushChar(ch) || summon;
    expect(summon?.kind).toBe('summon');

    const m2 = new TriggerMatcher();
    let part = null;
    for (const ch of 'hello cli') part = m2.pushChar(ch) || part;
    expect(part).toBeNull();
  });

  it('ESC fires escape', () => {
    expect(new TriggerMatcher().pushSpecial('escape')?.kind).toBe('escape');
  });

  it('redactSecrets strips card numbers + api keys, leaves ordinary text', () => {
    const red = redactSecrets('card 4111 1111 1111 1111 key sk-abcdefghijklmnop hi');
    expect(red).toMatch(/\[redacted-number\]/);
    expect(red).toMatch(/\[redacted-key\]/);
    expect(red).not.toMatch(/4111/);
    expect(redactSecrets('hello clippy how are you')).toBe('hello clippy how are you');
  });

  it('RollingBuffer redacts snapshots, evicts on its time window, clears', () => {
    const rb = new RollingBuffer(1000, 100);
    const t0 = 100000;
    for (const ch of 'hi 4111111111111111') rb.push(ch, t0);
    const snap = rb.snapshot(t0);
    expect(snap).toMatch(/\[redacted-number\]/);
    expect(snap).not.toMatch(/4111/);
    rb.push('x', t0 + 5000);
    expect(rb.snapshot(t0 + 5000)).toBe('x');
    rb.clear();
    expect(rb.snapshot(t0 + 5000)).toBe('');
  });
});

describe('input-summarizer', () => {
  it('gates short input, carries app + word count + tail', () => {
    expect(summarizeTyping({ app: 'Pages', recent: 'hi there' })).toBe('');
    const line = summarizeTyping({ app: 'Pages', recent: 'The quick brown fox jumps over the lazy dog' });
    expect(line).toMatch(/^\[typing\] /);
    expect(line).toContain('in Pages');
    expect(line).toContain('~9 words');
    expect(line).toContain('lazy dog');
  });

  it('omits the app cleanly, caps the tail, collapses whitespace', () => {
    const noApp = summarizeTyping({ recent: 'typing with no app context here' });
    expect(noApp.startsWith('[typing] User is currently typing (')).toBe(true);
    expect(noApp).not.toContain('undefined');

    const capped = summarizeTyping({ app: 'Notes', recent: 'start-marker ' + 'word '.repeat(200) + 'end-marker' });
    const quoted = (capped.match(/"([^"]*)"$/) || [])[1] || '';
    expect(quoted.startsWith('…')).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(281);
    expect(quoted).toContain('end-marker');
    expect(quoted).not.toContain('start-marker');

    const ws = summarizeTyping({ app: 'Mail', recent: 'dear  team,\n\nplease\tfind the report' });
    expect(ws).not.toMatch(/[\n\t]/);
    expect(ws).toContain('dear team, please find the report');
  });
});

describe('typing awareness is opt-in', () => {
  const brain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'brain.ts'), 'utf8').replace(/\r\n/g, '\n');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'), 'utf8');

  it('defaults to off in the brain settings store and in Settings', () => {
    expect(brain).toMatch(/inputAwarenessEnabled: false,/);
    expect(html).toMatch(/<input type="checkbox" id="setting-input-awareness" \/>/); // no `checked`
  });

  it('the monitor is only enabled behind darwin + awake + the opt-in', () => {
    const enables = [...brain.matchAll(/this\.inputMonitor\.enable\(\)/g)];
    expect(enables).toHaveLength(1);
    const before = brain.slice(Math.max(0, enables[0].index! - 200), enables[0].index!);
    expect(before).toMatch(/process\.platform === 'darwin' && this\.mode === 'awake' && settingsStore\.get\('inputAwarenessEnabled'\) === true/);
  });
});
