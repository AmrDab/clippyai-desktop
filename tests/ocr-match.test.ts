/**
 * v0.24 — OCR layout + multi-word matching (plan §3.4) and the region →
 * screen coordinate math the OCR path relies on (§3.5).
 */
import { describe, it, expect } from 'vitest';
import { layoutFromRegion, matchOcrTarget, scoreText, unionBox, type OcrBox } from '../src/main/ocr-match';

const w = (text: string, x: number, line: number, y = 10, width = text.length * 10, height = 20): OcrBox => ({ text, x, y, width, height, line });

describe('layoutFromRegion — region-relative boxes to screen pixels', () => {
  it('adds the capture origin (foreground-window crop)', () => {
    const l = layoutFromRegion({ region: { x: 300, y: 200, width: 800, height: 600, source: 'foreground' }, words: [w('Send', 5, 0)], fullText: 'Send' });
    expect(l.elements[0]).toMatchObject({ text: 'Send', x: 305, y: 210 });
    expect(l.region?.source).toBe('foreground');
  });

  it('handles a negative virtual-screen origin (monitor left of / above the primary)', () => {
    const l = layoutFromRegion({ region: { x: -1920, y: -120, width: 5760, height: 1200 }, words: [w('Inbox', 100, 0, 50)] });
    expect(l.elements[0]).toMatchObject({ x: -1820, y: -70 });
    // centre of the box is still on the left monitor
    const cx = l.elements[0].x + l.elements[0].width / 2;
    expect(cx).toBeLessThan(0);
  });

  it('builds one line box per OCR line (union of its words)', () => {
    const l = layoutFromRegion({ region: { x: 0, y: 0, width: 1, height: 1 }, words: [w('New', 10, 0, 10, 30, 20), w('message', 50, 0, 12, 70, 22), w('Inbox', 10, 1, 60)] });
    expect(l.lines).toHaveLength(2);
    expect(l.lines[0]).toMatchObject({ text: 'New message', x: 10, y: 10, width: 110, height: 24, line: 0 });
    expect(l.lines[1].text).toBe('Inbox');
  });

  it('missing region / words is not a crash', () => {
    expect(layoutFromRegion({})).toMatchObject({ elements: [], lines: [], fullText: '' });
    expect(unionBox([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('matchOcrTarget', () => {
  // A toolbar line: "Home  New message  Delete  Archive" plus a body line
  const words = [
    w('Home', 0, 0), w('New', 60, 0), w('message', 100, 0), w('Delete', 190, 0), w('Archive', 260, 0),
    w('Your', 0, 1, 60), w('new', 50, 1, 60), w('message', 90, 1, 60), w('from', 170, 1, 60), w('Bob', 220, 1, 60),
  ];

  it('matches a two-word label exactly as a span and clicks the phrase, not the line', () => {
    const m = matchOcrTarget('New message', words)!;
    expect(m.kind).toBe('span');
    expect(m.element.text).toBe('New message');
    expect(m.score).toBeGreaterThanOrEqual(1.0);
    // box covers just "New message" on line 0
    expect(m.element).toMatchObject({ x: 60, y: 10, width: 110 });
  });

  it('word-only matching could not do this (regression guard)', () => {
    const onlyWords = words.map((x) => ({ ...x, line: undefined }));
    const m = matchOcrTarget('New message', onlyWords);
    // every word is its own line → best is the 0.6 partial on "message"
    expect(m === null || m.score < 1).toBe(true);
  });

  it('is case/whitespace-insensitive', () => {
    expect(matchOcrTarget('  new   MESSAGE ', words)?.element.text).toBe('New message');
  });

  it('single-word targets still match the word', () => {
    const m = matchOcrTarget('Archive', words)!;
    expect(m).toMatchObject({ kind: 'word', score: 1.05 });
  });

  it('prefers the foreground window when the same label appears twice', () => {
    const twice = [w('Send', 10, 0, 10), w('Send', 1010, 1, 10)];
    const m = matchOcrTarget('Send', twice, { x: 1000, y: 0, width: 500, height: 500 })!;
    expect(m.element.x).toBe(1010);
  });

  it('long lines are considered as a whole (whole-word inside a line)', () => {
    const line = [w('Click', 0, 0), w('here', 60, 0), w('to', 110, 0), w('open', 140, 0), w('your', 190, 0), w('inbox', 240, 0), w('now', 300, 0)];
    const m = matchOcrTarget('open your inbox', line)!;
    expect(m.element.text).toBe('open your inbox');
    expect(m.score).toBeGreaterThanOrEqual(1);
  });

  it('returns null below the 0.5 threshold', () => {
    expect(matchOcrTarget('Settings', words)).toBeNull();
    expect(matchOcrTarget('', words)).toBeNull();
  });
});

describe('scoreText ladder (shared with smart-find.ps1)', () => {
  it.each([
    ['send', 'Send', 1.0],
    ['send', 'Send now', 0.9],
    ['to', 'To:', 0.9],
  ])('%s vs %s', (t, e, s) => { expect(scoreText(t, e)).toBeCloseTo(s, 5); });
  it('substring and reverse-substring are proportional', () => {
    expect(scoreText('mail', 'mailbox')).toBeCloseTo(0.7 * 4 / 7, 5);
    expect(scoreText('compose mail', 'compose')).toBeCloseTo(0.6 * 7 / 12, 5);
    expect(scoreText('xy', 'z')).toBe(0);
  });
});
