/**
 * v0.24.12 — desktop_screenshot captures the foreground window (win32). The
 * model clicks from these images, so the pixel → screen mapping is tested as
 * the hint states it. execFile is mocked, as in smart-click-win.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import os from 'os';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  clipboard: { availableFormats: () => [], readText: () => '', writeText: () => {} },
  BrowserWindow: class {}, screen: {}, shell: {}, nativeImage: {},
}));
vi.mock('../src/main/clawd-fallback', () => ({
  TIER5_FALLBACK_MAP: {}, ensureClawd: async () => false, isClawdReady: () => false,
  getClawdHandle: () => null, isClawdInstalled: () => false, callClawdTool: async () => ({ text: '' }),
  submitClawdTask: async () => ({ text: '' }),
}));

type Reply = { stdout: string } | Error;
let replies: Array<(args: string[]) => Reply | undefined> = [];
const calls: string[][] = [];
const execFileMock = vi.fn((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
  calls.push(args);
  for (const r of replies) {
    const reply = r(args);
    if (reply === undefined) continue;
    if (reply instanceof Error) { cb(reply); return; }
    cb(null, { stdout: reply.stdout, stderr: '' });
    return;
  }
  cb(new Error(`unexpected execFile: ${args.join(' ')}`));
});
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return { ...real, execFile: (...a: unknown[]) => (execFileMock as unknown as (...x: unknown[]) => void)(...a) };
});

import { executeTool } from '../src/main/tools';
import { shotMapping, shotToScreen, printedScale, windowShotHint } from '../src/main/screenshot-hint';

describe('pixel → screen mapping', () => {
  it('a small dialog is captured at native size: only the origin moves', () => {
    const region = { x: 1400, y: 900, width: 640, height: 360 };
    const m = shotMapping(region, 640);
    expect(m).toEqual({ originX: 1400, originY: 900, scale: 1 });
    expect(shotToScreen(m, 0, 0)).toEqual({ x: 1400, y: 900 });
    expect(shotToScreen(m, 320, 180)).toEqual({ x: 1720, y: 1080 });
    expect(shotToScreen(m, 639, 359)).toEqual({ x: 2039, y: 1259 });
  });

  it('a wide window is downscaled: origin plus scale', () => {
    const region = { x: 100, y: 50, width: 2560, height: 1600 };
    const m = shotMapping(region, 1024);
    expect(m.scale).toBe(2.5);
    expect(shotToScreen(m, 0, 0)).toEqual({ x: 100, y: 50 });
    expect(shotToScreen(m, 512, 320)).toEqual({ x: 1380, y: 850 });   // the centre of the image is the centre of the window
    expect(shotToScreen(m, 1024, 640)).toEqual({ x: 2660, y: 1650 }); // the far corner
  });

  it('a window on a monitor to the left has a negative origin', () => {
    const m = shotMapping({ x: -1920, y: 0, width: 1920, height: 1080 }, 1024);
    expect(shotToScreen(m, 512, 288)).toEqual({ x: -960, y: 540 });
  });

  it('the 3-decimal scale the hint prints stays within a pixel of the exact mapping', () => {
    for (const width of [1281, 1366, 1707, 1950, 2598, 3440, 3840, 5120]) {
      const region = { x: 37, y: -11, width, height: Math.round(width * 0.625) };
      const m = shotMapping(region, 1024);
      for (const sx of [0, 1, 333, 777, 1023]) {
        const exact = region.x + sx * (width / 1024);
        expect(Math.abs(shotToScreen(m, sx, 0).x - exact)).toBeLessThanOrEqual(1);
      }
      expect(printedScale(m)).toBeCloseTo(width / 1024, 3);
    }
  });
});

describe('windowShotHint', () => {
  it('window, downscaled: the expression has the origin and the scale', () => {
    const t = windowShotHint({ region: { x: 100, y: 50, width: 2560, height: 1600 }, finalW: 1024, finalH: 640, window: '"Inbox" (olk)' });
    expect(t).toContain('Screenshot of the foreground window "Inbox" (olk): 1024x640 image of the screen area at (100,50), 2560x1600 native pixels, scale 2.500x.');
    expect(t).toContain('call mouse_click(round(100 + sx*2.500), round(50 + sy*2.500)).');
    expect(t).toContain('do NOT convert those');
    expect(t).toContain('region:"screen"');
  });
  it('window at native size: plain addition, no rounding needed', () => {
    const t = windowShotHint({ region: { x: 1400, y: 900, width: 640, height: 360 }, finalW: 640, finalH: 360, window: '"Save As" (Notepad)' });
    expect(t).toContain('call mouse_click(1400 + sx, 900 + sy).');
    expect(t).not.toContain('scale');
  });
  it('negative origin reads as a subtraction', () => {
    const t = windowShotHint({ region: { x: -1920, y: 0, width: 1920, height: 1080 }, finalW: 1024, finalH: 576, window: '"A" (b)' });
    expect(t).toContain('call mouse_click(round(sx*1.875 - 1920), round(sy*1.875)).');
  });
  it('whole screen: the old factor-only expression, and native passes straight through', () => {
    expect(windowShotHint({ region: { x: 0, y: 0, width: 3840, height: 2400 }, finalW: 1024, finalH: 640 }))
      .toContain('Screenshot of the whole screen: 1024x640 image of the screen area at (0,0), 3840x2400 native pixels, scale 3.750x. To click a pixel you see in this image at (sx,sy), call mouse_click(round(sx*3.750), round(sy*3.750)).');
    expect(windowShotHint({ region: { x: 0, y: 0, width: 1280, height: 720 }, finalW: 1280, finalH: 720 }))
      .toContain('Coordinates here ARE native pixels; pass directly to mouse_click.');
  });
  it('the expression in the hint and shotToScreen agree', () => {
    const region = { x: 311, y: 299, width: 1776, height: 1187 };
    const t = windowShotHint({ region, finalW: 1024, finalH: 684, window: '"n" (p)' });
    const m = /mouse_click\(round\((\d+) \+ sx\*([\d.]+)\), round\((\d+) \+ sy\*([\d.]+)\)\)/.exec(t)!;
    const viaHint = { x: Math.round(Number(m[1]) + 700 * Number(m[2])), y: Math.round(Number(m[3]) + 400 * Number(m[4])) };
    expect(viaHint).toEqual(shotToScreen(shotMapping(region, 1024), 700, 400));
  });
});

const script = (name: string) => (args: string[]) => args.some((a) => a.endsWith(name));
const isCapture = (args: string[]) => args.some((a) => a.includes('CopyFromScreen'));
const FG = { stdout: '{"handle":5,"processId":700,"processName":"Notepad","title":"Save As","bounds":{"x":1400,"y":900,"width":640,"height":360},"success":true}' };

const originalPlatform = process.platform;
describe('desktop_screenshot (win32)', () => {
  beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
  afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });
  beforeEach(() => { replies = []; calls.length = 0; execFileMock.mockClear(); });

  it('captures the foreground window frame and explains the mapping', async () => {
    replies = [(a) => (script('get-foreground-window.ps1')(a) ? FG : undefined), (a) => (isCapture(a) ? { stdout: '640 360 640 360 1400 900 1\nQUJD\n' } : undefined)];
    const r = await executeTool('desktop_screenshot', {});
    expect(calls.find(isCapture)!.join(' ')).toContain('System.Drawing.Rectangle(1400,900,640,360)');
    expect(r.text).toContain('Screenshot of the foreground window "Save As" (Notepad): 640x360 image of the screen area at (1400,900)');
    expect(r.text).toContain('mouse_click(1400 + sx, 900 + sy)');
    expect(r.image).toEqual({ data: 'QUJD', mimeType: 'image/png' });
  });

  it('region:"screen" captures the whole screen without asking for the window', async () => {
    replies = [(a) => (isCapture(a) ? { stdout: '3840 2400 1024 640 0 0 0\nQUJD\n' } : undefined)];
    const r = await executeTool('desktop_screenshot', { region: 'screen' });
    expect(calls.some(script('get-foreground-window.ps1'))).toBe(false);
    expect(calls.find(isCapture)!.join(' ')).toContain('System.Drawing.Rectangle(0,0,0,0)');
    expect(r.text).toContain('Screenshot of the whole screen: 1024x640');
    expect(r.text).toContain('mouse_click(round(sx*3.750), round(sy*3.750))');
  });

  it('a window frame the script could not use (off screen) is reported as the whole screen it captured', async () => {
    replies = [(a) => (script('get-foreground-window.ps1')(a) ? FG : undefined), (a) => (isCapture(a) ? { stdout: '1920 1080 1024 576 0 0 0\nQUJD\n' } : undefined)];
    const r = await executeTool('desktop_screenshot', {});
    expect(r.text).toContain('Screenshot of the whole screen');
    expect(r.text).not.toContain('Save As');
  });

  it('a clipped window uses the origin the script reports, not the one asked for', async () => {
    replies = [(a) => (script('get-foreground-window.ps1')(a) ? FG : undefined), (a) => (isCapture(a) ? { stdout: '1950 1500 1024 788 0 100 1\nQUJD\n' } : undefined)];
    const r = await executeTool('desktop_screenshot', {});
    expect(r.text).toContain('at (0,100), 1950x1500 native pixels, scale 1.904x');
    expect(r.text).toContain('mouse_click(round(sx*1.904), round(100 + sy*1.904))');
  });
});
