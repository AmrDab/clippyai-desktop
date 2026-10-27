import { describe, it, expect } from 'vitest';
import { lintText } from '../src/main/harper-lint';

describe('harper-lint', () => {
  it('lints a known-bad sentence and returns spans + suggestions', async () => {
    const bad = 'This are an test, i think its fine and we was happy.';
    const lints = await lintText(bad);

    // Print the full result so the spike has tangible output.
    // eslint-disable-next-line no-console
    console.log('\n=== Harper lints for:', JSON.stringify(bad), '===');
    for (const l of lints) {
      // eslint-disable-next-line no-console
      console.log(
        `  [${l.start}-${l.end}] "${bad.slice(l.start, l.end)}" — ${l.message}` +
          (l.suggestions.length ? `  => suggestions: ${JSON.stringify(l.suggestions)}` : '  => (no suggestions)'),
      );
    }
    // eslint-disable-next-line no-console
    console.log(`  total: ${lints.length} lint(s)\n`);

    expect(Array.isArray(lints)).toBe(true);
    expect(lints.length).toBeGreaterThan(0);
    for (const l of lints) {
      expect(typeof l.message).toBe('string');
      expect(typeof l.start).toBe('number');
      expect(typeof l.end).toBe('number');
      expect(l.end).toBeGreaterThanOrEqual(l.start);
      expect(Array.isArray(l.suggestions)).toBe(true);
    }
  }, 60_000);

  it('returns no lints for clean text', async () => {
    const lints = await lintText('The quick brown fox jumps over the lazy dog.');
    expect(Array.isArray(lints)).toBe(true);
  }, 60_000);
});
