/**
 * v0.24.12 — the text Clippy itself adds to tool results (hints, outcome
 * lines, the screenshot mapping) goes through the injection scan like the
 * rest of the result. It must never be what raises the security notice.
 */
import { describe, it, expect } from 'vitest';
import { guardUntrusted, modelFacing } from '../src/main/result-budget';
import { renderScreenLines, formatWinScreen } from '../src/main/screen-lines';
import { reportUiaClick, outcomeLine } from '../src/main/click-report';
import { windowShotHint } from '../src/main/screenshot-hint';
import { notRunAfterFailure } from '../src/main/tool-loop-detection';
import { toSendKeys } from '../src/main/sendkeys';

const nodes = Array.from({ length: 200 }, (_, i) => ({ d: i % 3, role: 'Button', name: `Button ${i}`, actions: 'invoke' }));
const texts: Record<string, string> = {
  'read_screen, truncated': renderScreenLines({ header: 'Foreground window: "Inbox - Mail" (olk)', nodes, truncated: true, others: ['"Notes" (Notepad)'] }).text,
  'read_screen, empty': renderScreenLines({ header: 'Foreground window: "Game" (game)', nodes: [] }).text,
  'read_screen, find with rects': formatWinScreen(JSON.stringify({ focusedHandle: 1, focusedTitle: 'Paint', focusedProcess: 'mspaint', nodes: [{ d: 0, role: 'Pane', name: 'Canvas', rect: [1, 2, 3, 4] }], windows: [] }), { find: 'canvas' })!.text,
  'smart_click confirmed': reportUiaClick('Remember me', { name: 'Remember me', controlType: 'CheckBox', method: 'uia-toggle', before: 'unchecked', after: 'checked', changed: ['"Remember me": unchecked -> checked'] }).text,
  'smart_click did nothing': reportUiaClick('High', { name: 'High', controlType: 'ListItem', method: 'uia-select', before: '', after: '', changed: [] }).text,
  'smart_click classic': reportUiaClick('High', { name: 'High', controlType: 'ListItem', method: 'uia-coords', classic: true, before: '', after: '(gone)', gone: true, changed: ['a popup closed', 'focus: ComboBox "Priority" = "High"'] }).text,
  'smart_click no change': reportUiaClick('Save', { name: 'Save', controlType: 'Button', method: 'uia-invoke', before: '', after: '', changed: [] }).text,
  'not found line': outcomeLine('failed', 'UI_NOT_FOUND', 'read_screen with find to get the exact name, or desktop_screenshot then mouse_click'),
  'timeout line': outcomeLine('failed', 'TIMEOUT', 'it may or may not have clicked; read_screen before trying again'),
  'screenshot, window': windowShotHint({ region: { x: 100, y: 50, width: 2560, height: 1600 }, finalW: 1024, finalH: 640, window: '"Inbox" (olk)' }),
  'screenshot, screen': windowShotHint({ region: { x: 0, y: 0, width: 3840, height: 2400 }, finalW: 1024, finalH: 640 }),
  'not run': notRunAfterFailure('smart_click'),
  'open_app existing': "Focused an existing notepad window (pid 4321); it may hold the user's unsaved work — start a new document (ctrl+n) before typing, and do not select all or replace what is already there",
  'key_press error': `(error:INVALID_KEY) key_press: ${(toSendKeys('%{F4}') as { error: string }).error}`,
  'key_press unknown': `(error:INVALID_KEY) key_press: ${(toSendKeys('ctrl+entr') as { error: string }).error}`,
  'truncation marker': modelFacing('smart_click', 'x'.repeat(5000)).text,
};

describe("Clippy's own result text does not raise the injection notice", () => {
  it.each(Object.entries(texts))('%s', (_name, text) => {
    const g = guardUntrusted(text);
    expect(g.fired, JSON.stringify(g.gate)).toBe(false);
  });
});
