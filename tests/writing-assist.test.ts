import { describe, it, expect } from 'vitest';
import { applyLints } from '../src/main/writing-assist';
import { lintText } from '../src/main/harper-lint';

describe('applyLints (pure)', () => {
  it('applies suggestions sorted by start descending so offsets stay valid', () => {
    const original = 'aXc';
    // Two non-overlapping single-char replacements. If applied left-to-right
    // without descending sort, the second splice would land at a stale offset.
    const out = applyLints(original, [
      { start: 0, end: 1, suggestions: ['AAAA'] }, // 'a' -> 'AAAA'
      { start: 2, end: 3, suggestions: ['C'] },    // 'c' -> 'C'
    ]);
    expect(out).toBe('AAAAXC');
  });

  it('skips lints whose first suggestion is empty', () => {
    const out = applyLints('hello world', [
      { start: 0, end: 5, suggestions: [''] },        // empty -> skipped
      { start: 6, end: 11, suggestions: ['planet'] }, // applied
    ]);
    expect(out).toBe('hello planet');
  });

  it('skips lints with no suggestions at all', () => {
    const out = applyLints('untouched', [{ start: 0, end: 9, suggestions: [] }]);
    expect(out).toBe('untouched');
  });

  it('uses the first NON-EMPTY suggestion when earlier ones are empty', () => {
    const out = applyLints('teh', [{ start: 0, end: 3, suggestions: ['', 'the'] }]);
    expect(out).toBe('the');
  });

  it('returns the original unchanged when there are no lints', () => {
    expect(applyLints('nothing to fix', [])).toBe('nothing to fix');
  });
});

describe('applyLints + Harper (integration)', () => {
  it('corrects a known-bad sentence using real Harper lints', async () => {
    const bad = 'This are an test';
    const lints = await lintText(bad);
    expect(lints.length).toBeGreaterThan(0);

    const corrected = applyLints(bad, lints);

    // eslint-disable-next-line no-console
    console.log('\n=== applyLints ===');
    // eslint-disable-next-line no-console
    console.log('  original :', JSON.stringify(bad));
    // eslint-disable-next-line no-console
    console.log('  corrected:', JSON.stringify(corrected));
    // eslint-disable-next-line no-console
    console.log(`  applied ${lints.length} lint(s)\n`);

    // The correction must actually change the text and resolve the grammar
    // problems Harper flagged (re-linting the result yields fewer issues).
    expect(corrected).not.toBe(bad);
    const reLinted = await lintText(corrected);
    expect(reLinted.length).toBeLessThan(lints.length);
  }, 60_000);
});
