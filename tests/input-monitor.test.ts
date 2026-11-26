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

import path from 'path';
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

describe('InputMonitor — "hey clippy" wake mode', () => {
  const line = (o: object) => child.stdout.emit('data', JSON.stringify(o) + '\n');
  const typeKeys = (text: string) => { for (const ch of text) line({ t: 'key', ch }); };
  const sent = () => child.stdin.write.mock.calls.map((c) => String(c[0]));

  it("enableWake() sends 'enable-wake'; the phrase fires onWake and never reaches the rolling buffer", () => {
    const onWake = vi.fn();
    const mon = new InputMonitor({ onWake });
    mon.enableWake();
    expect(sent()).toContain('enable-wake\n');
    expect(mon.isEnabled()).toBe(false); // full typing awareness stays off
    typeKeys('hey clippy');
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(mon.recentContext()).toBe('');
  });

  it("'reset' and the clearing specials break the phrase; backspace edits it", () => {
    const onWake = vi.fn();
    const mon = new InputMonitor({ onWake });
    mon.enableWake();
    typeKeys('hey cl');
    line({ t: 'reset' });
    typeKeys('ippy');
    typeKeys(' hey clip');
    line({ t: 'special', key: 'return' });
    typeKeys('py');
    expect(onWake).not.toHaveBeenCalled();
    typeKeys(' hey clippx');
    line({ t: 'special', key: 'backspace' });
    typeKeys('y');
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('full mode matches the phrase only when asked, and never for keys a process posted', () => {
    const onWake = vi.fn();
    const mon = new InputMonitor({ onWake });
    mon.enable();
    expect(sent()).toContain('enable\n');
    typeKeys('hey clippy');
    expect(onWake).not.toHaveBeenCalled();

    mon.enable(true);
    for (const ch of ' hey clippy') line({ t: 'key', ch, syn: true });
    expect(onWake).not.toHaveBeenCalled();
    typeKeys(' hey clippy');
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('disable() stops matching', () => {
    const onWake = vi.fn();
    const mon = new InputMonitor({ onWake });
    mon.enableWake();
    mon.disable();
    expect(sent()).toContain('disable\n');
    typeKeys('hey clippy');
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe('resolveMonitorPath — Windows', () => {
  it('finds clippy-input-monitor.exe (bundled, then the dev build)', async () => {
    const proc = process as { resourcesPath?: string };
    const realPlatform = process.platform;
    const realResources = proc.resourcesPath;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      vi.resetModules();
      proc.resourcesPath = path.join('ClippyAI', 'resources');
      const bundled = (await import('../src/main/input-monitor')).resolveMonitorPath();
      expect(bundled).toBe(path.join('ClippyAI', 'resources', 'clippy-input-monitor.exe'));

      vi.resetModules();
      proc.resourcesPath = undefined;
      const dev = (await import('../src/main/input-monitor')).resolveMonitorPath();
      expect(dev).toBe(path.join(__dirname, '..', 'native', 'clippy-input-monitor-win', '.build', 'clippy-input-monitor.exe'));
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform });
      proc.resourcesPath = realResources;
    }
  });
});
