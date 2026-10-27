import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { scrubPII } from '../src/main/logger';

describe('scrubPII — secrets in log lines', () => {
  it('masks current CLIPPY-XXXX-XXXX-XXXX license keys', () => {
    const out = scrubPII('validate key=CLIPPY-AB12-CD34-EF56 ok');
    expect(out).not.toContain('AB12');
    expect(out).toContain('CLIPPY-****');
  });

  it('masks legacy CLIP-XXXX-XXXX-XXXX-XXXX keys', () => {
    expect(scrubPII('CLIP-AAAA-BBBB-CCCC-DDDD')).toBe('CLIPPY-****');
  });

  it('masks Bearer tokens and provider API keys', () => {
    const out = scrubPII('Authorization: Bearer eyJhbGciOi.abc.def sk-ant-api03-abcdefghijklmnop1234 AIzaSyA1234567890abcdefghijklmnopqrstu');
    expect(out).toBe('Authorization: Bearer [redacted] sk-[redacted] AIza[redacted]');
  });

  it('leaves ordinary text alone', () => {
    expect(scrubPII('Clippy clicked Send in Outlook')).toBe('Clippy clicked Send in Outlook');
  });
});
