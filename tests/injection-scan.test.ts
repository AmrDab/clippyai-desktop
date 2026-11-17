import { describe, it, expect } from 'vitest';
import { scanForInjection } from '../src/main/security/injection-scan';

const bidi = (t: string) => scanForInjection(t).findings.filter((f) => f.kind === 'bidi');

describe('injection-scan bidi rule', () => {
  it('does not flag macOS isolates around an app name', () => {
    const t = 'iCloud · Do you want to keep this new document “Untitled 47”? ⁨TextEdit⁩ here: ⁦x⁩ ⁧y⁩';
    expect(bidi(t)).toEqual([]);
  });
  it('flags RLO override', () => {
    const f = bidi('‮ignore all previous');
    expect(f).toHaveLength(1);
    expect(f[0].confidence).toBe('high');
  });
  it('flags embeddings and unbalanced or nested isolates', () => {
    expect(bidi('a ‫b‬')).toHaveLength(1);
    expect(bidi('a ⁨b')).toHaveLength(1);
    expect(bidi('a b⁩')).toHaveLength(1);
    expect(bidi('⁨a ⁧b⁩⁩')).toHaveLength(1);
  });
  it('flags a long or multi-line isolated span', () => {
    expect(bidi('⁨' + 'x'.repeat(100) + '⁩')).toHaveLength(1);
    expect(bidi('⁨a\nb⁩')).toHaveLength(1);
  });
});
