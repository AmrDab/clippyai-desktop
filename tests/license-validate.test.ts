/**
 * v0.24.12 — license validation: what clears the key, and the 5 s abort.
 * electron's net and electron-store are mocked; nothing goes on the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import os from 'os';

const { mem } = vi.hoisted(() => ({ mem: new Map<string, unknown>() }));
vi.mock('electron-store', () => ({
  default: class {
    constructor(opts: { defaults?: Record<string, unknown> } = {}) {
      for (const [k, v] of Object.entries(opts.defaults ?? {})) if (!mem.has(k)) mem.set(k, v);
    }
    get(k: string) { return mem.get(k); }
    set(k: string, v: unknown) { mem.set(k, v); }
    delete(k: string) { mem.delete(k); }
    clear() { mem.clear(); }
  },
}));

class FakeRequest extends EventEmitter {
  aborted = false;
  body = '';
  setHeader(): void { /* not needed */ }
  write(s: string): void { this.body += s; }
  end(): void { /* the test answers, or not */ }
  abort(): void { this.aborted = true; }
  /** Answer like the server would. */
  respond(statusCode: number, body: string): void {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = statusCode;
    this.emit('response', res);
    res.emit('data', Buffer.from(body));
    res.emit('end');
  }
}
let lastReq: FakeRequest;
vi.mock('electron', () => ({
  net: { request: () => (lastReq = new FakeRequest()) },
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false },
}));
vi.mock('../src/main/skills/secrets', () => ({ clearAllSecrets: async () => {} }));

import { classifyValidateResponse, VALIDATE_TIMEOUT_MS } from '../src/main/license-verdict';
import { validateLicenseKey, revalidateIfNeeded } from '../src/main/license';

describe('classifyValidateResponse', () => {
  it('valid: any non-5xx answer with {valid:true}', () => {
    expect(classifyValidateResponse(200, '{"valid":true,"plan":"pro"}')).toEqual({ kind: 'valid', plan: 'pro' });
    expect(classifyValidateResponse(200, '{"valid":true}')).toEqual({ kind: 'valid' });
  });
  it('invalid: only HTTP 200 with {valid:false}', () => {
    expect(classifyValidateResponse(200, '{"valid":false}')).toEqual({ kind: 'invalid' });
  });
  it('a 4xx carrying {valid:false} does not revoke', () => {
    for (const status of [400, 401, 403, 404, 429]) expect(classifyValidateResponse(status, '{"valid":false}')).toEqual({ kind: 'unreachable' });
  });
  it('5xx, HTML, empty and malformed bodies are unreachable', () => {
    expect(classifyValidateResponse(500, '{"valid":false}')).toEqual({ kind: 'unreachable' });
    expect(classifyValidateResponse(503, '{"valid":true}')).toEqual({ kind: 'unreachable' });
    expect(classifyValidateResponse(200, '<html>login to wifi</html>')).toEqual({ kind: 'unreachable' });
    expect(classifyValidateResponse(200, '')).toEqual({ kind: 'unreachable' });
    expect(classifyValidateResponse(200, '{"ok":true}')).toEqual({ kind: 'unreachable' });
    expect(classifyValidateResponse(200, 'null')).toEqual({ kind: 'unreachable' });
    expect(classifyValidateResponse(undefined, '{"valid":false}')).toEqual({ kind: 'unreachable' });
  });
});

describe('validateLicenseKey / revalidateIfNeeded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mem.set('licenseKey', 'CLIPPY-TEST-TEST-TEST');
    mem.set('plan', 'pro');
    mem.set('lastValidated', 0);
    mem.set('graceExpiry', 0);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a server that never answers: aborted after 5 s, grace, key kept, launch goes on', async () => {
    const p = revalidateIfNeeded();
    await vi.advanceTimersByTimeAsync(VALIDATE_TIMEOUT_MS - 1);
    expect(lastReq.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastReq.aborted).toBe(true);
    expect(await p).toBe(true);
    expect(mem.get('licenseKey')).toBe('CLIPPY-TEST-TEST-TEST');
    expect(mem.get('graceExpiry') as number).toBeGreaterThan(Date.now());
  });

  it('an answer after the abort changes nothing', async () => {
    const p = validateLicenseKey('CLIPPY-TEST-TEST-TEST');
    await vi.advanceTimersByTimeAsync(VALIDATE_TIMEOUT_MS);
    lastReq.respond(200, '{"valid":false}');
    expect(await p).toEqual({ state: 'unreachable', plan: 'pro' });
  });

  it('HTTP 200 {valid:false} clears the key', async () => {
    const p = revalidateIfNeeded();
    lastReq.respond(200, '{"valid":false}');
    expect(await p).toBe(false);
    expect(mem.get('licenseKey')).toBeFalsy();
  });

  it('HTTP 403 {valid:false} keeps the key (grace)', async () => {
    const p = revalidateIfNeeded();
    lastReq.respond(403, '{"valid":false}');
    expect(await p).toBe(true);
    expect(mem.get('licenseKey')).toBe('CLIPPY-TEST-TEST-TEST');
  });

  it('a valid answer is stored and the timer is cleared', async () => {
    const p = validateLicenseKey('CLIPPY-TEST-TEST-TEST');
    lastReq.respond(200, '{"valid":true,"plan":"power"}');
    expect(await p).toEqual({ state: 'valid', plan: 'power' });
    expect(mem.get('plan')).toBe('power');
    expect(vi.getTimerCount()).toBe(0);
  });
});
