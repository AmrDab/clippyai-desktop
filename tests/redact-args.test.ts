import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { redactArgs } from '../src/main/logger';

describe('redactArgs', () => {
  it('redacts secret-looking keys', () => {
    const out = redactArgs({ password: 'x', apiKey: 'y', api_key: 'z', headers: { Authorization: 'Bearer t' }, cookie: 'c', token: 't' });
    for (const k of Object.keys(out)) expect(out[k]).toBe('[redacted]');
  });

  it('replaces free-text keys with their length', () => {
    expect(redactArgs({ text: 'hello', body: 'abc' })).toEqual({ text: { len: 5 }, body: { len: 3 } });
  });

  it('truncates other strings to 80 chars', () => {
    const long = 'a'.repeat(200);
    const out = redactArgs({ path: long, short: 'ok' });
    expect((out.path as string).length).toBe(81);
    expect(out.short).toBe('ok');
  });

  it('reduces nested objects to their keys and passes primitives through', () => {
    expect(redactArgs({ opts: { a: 1, b: 2 }, n: 3, flag: true })).toEqual({ opts: { keys: ['a', 'b'] }, n: 3, flag: true });
  });

  it('tolerates non-object input', () => {
    expect(redactArgs(undefined)).toEqual({});
    expect(redactArgs('str')).toEqual({});
  });
});
