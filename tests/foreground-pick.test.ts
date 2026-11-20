/**
 * v0.24.12 — the foreground picker. The fixture styles are the real values
 * read on the Windows 11 PC where every task started "in" a notch overlay
 * (titles replaced).
 */
import { describe, it, expect } from 'vitest';
import { pickUserWindow, overlayReason, parseForegroundSnapshot, activeWindowJson, type WinCandidate } from '../src/main/foreground-pick';

const OWN = 13788;
const w = (handle: number, processName: string, processId: number, exStyle: number, style: number, bounds: [number, number, number, number], title = `${processName} window`, minimized = false): WinCandidate =>
  ({ handle, processName, processId, exStyle, style, minimized, title, bounds: { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] } });

// Front to back, as EnumWindows returned them.
const TASKBAR_2 = w(1, 'explorer', 500, 0x00000088, 0x96000000, [2796, -48, 1920, 48], '');
const CLIPPY = w(2, 'ClippyAI', OWN, 0x00080008, 0x14030000, [2720, 999, 855, 945], 'ClippyAI');
const TASKBAR = w(3, 'explorer', 500, 0x00000088, 0x96000000, [0, 2292, 3840, 108], '');
const NOTCH = w(4, 'NotchBar', 21540, 0x08280028, 0x14020000, [1112, 0, 1620, 990], 'NotchBar');
const MAIL = w(5, 'olk', 700, 0x00200100, 0x17cf0000, [0, 0, 3840, 2292], 'Inbox - Outlook');
const EDGE = w(6, 'msedge', 800, 0x00200100, 0x17cf0000, [0, 0, 3840, 2292], 'Docs - Edge');
const HIDDEN_HOST = w(7, 'powershell', 900, 0x08200080, 0x94000000, [0, 0, 0, 0], '');
const NOTEPAD_MIN = w(8, 'Notepad', 950, 0x00000110, 0x34cf0000, [-31988, -32000, 329, 44], 'notes.txt - Notepad', true);
const DESKTOP = w(9, 'explorer', 500, 0x00200080, 0x96000000, [0, -1080, 4716, 3480], 'Program Manager');
const ALL = [TASKBAR_2, CLIPPY, TASKBAR, NOTCH, MAIL, EDGE, HIDDEN_HOST, NOTEPAD_MIN, DESKTOP];

describe('overlayReason', () => {
  it('names why a window is not an app window', () => {
    expect(overlayReason(TASKBAR)).toBe('tool_window');
    expect(overlayReason(NOTCH)).toBe('topmost_noactivate');
    expect(overlayReason(w(1, 'hud', 1, 0x00080020, 0x94000000, [0, 0, 3840, 2400]))).toBe('click_through');
    expect(overlayReason(w(1, 'badge', 1, 0x00000008, 0x94000000, [100, 100, 300, 80]))).toBe('small_overlay');
  });
  it('real app windows pass, including ones that are always on top or have no title bar', () => {
    expect(overlayReason(MAIL)).toBeNull();
    expect(overlayReason(w(1, 'calc', 1, 0x00000108, 0x14cf0000, [0, 0, 300, 400]))).toBeNull();        // small, topmost, but has a title bar
    expect(overlayReason(w(1, 'player', 1, 0x00000008, 0x96000000, [0, 0, 3840, 2400]))).toBeNull();     // frameless full screen
    expect(overlayReason(w(1, 'pinned', 1, 0x00040008, 0x94000000, [0, 0, 300, 80]))).toBeNull();        // WS_EX_APPWINDOW: in the taskbar
  });
});

describe('pickUserWindow', () => {
  it('the bug: Clippy in front, a notch overlay next in Z-order → the mail app, not the overlay', () => {
    expect(pickUserWindow({ foreground: CLIPPY.handle, candidates: ALL }, OWN)).toBe(MAIL);
  });
  it('a real app in the foreground is taken as is', () => {
    expect(pickUserWindow({ foreground: EDGE.handle, candidates: ALL }, OWN)).toBe(EDGE);
  });
  it('an overlay that holds the foreground is skipped too', () => {
    expect(pickUserWindow({ foreground: NOTCH.handle, candidates: ALL }, OWN)).toBe(MAIL);
    expect(pickUserWindow({ foreground: TASKBAR.handle, candidates: ALL }, OWN)).toBe(MAIL);
  });
  it('minimized, zero-size and untitled windows are not picked from the Z-order', () => {
    const untitled = w(20, 'ghost', 2, 0x00000100, 0x14cf0000, [0, 0, 800, 600], '   ');
    expect(pickUserWindow({ foreground: CLIPPY.handle, candidates: [CLIPPY, NOTEPAD_MIN, HIDDEN_HOST, untitled, EDGE] }, OWN)).toBe(EDGE);
  });
  it('an untitled app window that really is the foreground is kept', () => {
    const untitled = w(20, 'game', 2, 0x00000100, 0x14cf0000, [0, 0, 800, 600], '');
    expect(pickUserWindow({ foreground: 20, candidates: [untitled, EDGE] }, OWN)).toBe(untitled);
  });
  it('nothing but overlays: the foreground overlay rather than nothing; never Clippy itself', () => {
    expect(pickUserWindow({ foreground: NOTCH.handle, candidates: [CLIPPY, NOTCH, TASKBAR] }, OWN)).toBe(NOTCH);
    expect(pickUserWindow({ foreground: CLIPPY.handle, candidates: [CLIPPY, NOTCH, TASKBAR] }, OWN)).toBeNull();
    expect(pickUserWindow({ foreground: 0, candidates: [] }, OWN)).toBeNull();
  });
  it('another window of Clippy (Settings, Logs) is never the user window', () => {
    const settings = w(30, 'ClippyAI', OWN, 0x00000100, 0x14cf0000, [0, 0, 900, 700], 'ClippyAI Settings');
    expect(pickUserWindow({ foreground: 30, candidates: [settings, CLIPPY, MAIL] }, OWN)).toBe(MAIL);
  });
});

describe('script output', () => {
  it('parses the snapshot; an older shape or an error is null', () => {
    expect(parseForegroundSnapshot(JSON.stringify({ foreground: 5, candidates: ALL, success: true }))?.candidates).toHaveLength(ALL.length);
    expect(parseForegroundSnapshot('{"handle":4242,"processId":777,"processName":"msedge","title":"Inbox","success":true}')).toBeNull();
    expect(parseForegroundSnapshot('{"error":"x"}')).toBeNull();
    expect(parseForegroundSnapshot('(no active window)')).toBeNull();
  });
  it('get_active_window keeps its shape', () => {
    expect(JSON.parse(activeWindowJson(MAIL))).toEqual({ handle: 5, processId: 700, processName: 'olk', title: 'Inbox - Outlook', bounds: { x: 0, y: 0, width: 3840, height: 2292 }, success: true });
  });
});
