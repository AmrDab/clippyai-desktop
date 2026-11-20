/** v0.24.12 — a helper that fails to start must not crash the main process. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
}
let child: FakeChild;
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn: () => (child = new FakeChild()) }));
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>();
  const existsSync = (p: unknown) => String(p).includes('clippy-input-monitor') || real.existsSync(p as string);
  return { ...real, default: { ...real, existsSync }, existsSync };
});
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => process.cwd(), isPackaged: false } }));

import { InputMonitor } from '../src/main/input-monitor';

describe('InputMonitor — helper process errors', () => {
  let mon: InputMonitor;
  beforeEach(() => { mon = new InputMonitor(); expect(mon.start()).toBe(true); });

  it("an 'error' event from the helper (ENOENT / EACCES) is handled, and capture is off", () => {
    mon.enable();
    expect(mon.isEnabled()).toBe(true);
    expect(child.listenerCount('error')).toBe(1);
    // With no listener, EventEmitter throws on 'error': that was the crash.
    expect(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))).not.toThrow();
    expect(mon.isEnabled()).toBe(false);
  });

  it('after the error the monitor can be started again', () => {
    child.emit('error', new Error('spawn ENOENT'));
    const dead = child;
    expect(mon.start()).toBe(true);
    expect(child).not.toBe(dead);
  });

  it('a write error on a dead helper (EPIPE) is handled too', () => {
    expect(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  });
});
