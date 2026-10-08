import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * v0.20.3 — regression guard for the v0.20.0 port bug: tool implementations in
 * tools.ts had a darwin (Swift bridge) branch and then fell through to
 * AppleScript/osascript on EVERY other platform, so on Windows read_screen,
 * get_active_window, type_text, mouse_click, ... all failed with
 * "spawn osascript ENOENT".
 *
 * Static check: for every top-level function in src/main/tools.ts, each call
 * that reaches osascript / a mac-only CLI (runApplescript, asValue, runCli,
 * getAppPidByName, sendViaAppleMail, sendViaOutlookMac) must either
 *   (a) sit inside an `if (process.platform === 'darwin' ...) { ... }` block, or
 *   (b) be preceded in the same function by a win32 guard
 *       (`process.platform === 'win32'` / `process.platform !== 'darwin'`)
 *       that returns before the AppleScript path.
 */

const SRC = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'main', 'tools.ts'), 'utf8')
  .replace(/\r\n/g, '\n');

const MAC_CALL_RE = /\b(runApplescript|asValue|runCli|getAppPidByName|sendViaAppleMail|sendViaOutlookMac)\(|osascript/g;
const FN_RE = /^(?:export )?(?:async )?function (\w+)\s*\(/gm;
const DARWIN_IF_RE = /if \(process\.platform === 'darwin'[^{]*\{/g;
const WIN32_GUARD_RE = /process\.platform === 'win32'|process\.platform !== 'darwin'/;

interface Fn { name: string; body: string }

function splitFunctions(src: string): Fn[] {
  const starts: Array<{ name: string; idx: number }> = [];
  for (const m of src.matchAll(FN_RE)) starts.push({ name: m[1], idx: m.index! });
  return starts.map((s, i) => ({
    name: s.name,
    body: src.slice(s.idx, i + 1 < starts.length ? starts[i + 1].idx : src.length),
  }));
}

/** [start, end) ranges of every `if (process.platform === 'darwin' …) { … }` block. */
function darwinBlockRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of body.matchAll(DARWIN_IF_RE)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) { ranges.push([open, i + 1]); break; }
    }
  }
  return ranges;
}

describe('tools.ts never reaches osascript on win32', () => {
  const fns = splitFunctions(SRC);

  it('parses tools.ts into functions', () => {
    expect(fns.length).toBeGreaterThan(50);
    expect(fns.map((f) => f.name)).toContain('getActiveWindow');
  });

  const offenders: string[] = [];
  for (const fn of fns) {
    // Skip the mac-only helpers' own definitions in mac-bridge (not here) —
    // we only inspect tools.ts bodies. Strip comments so prose mentioning
    // "osascript" doesn't count.
    const code = fn.body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const ranges = darwinBlockRanges(code);
    const bodyStart = code.indexOf('{'); // skip the function's own signature
    for (const m of code.matchAll(MAC_CALL_RE)) {
      const at = m.index!;
      if (at < bodyStart) continue;
      const insideDarwin = ranges.some(([a, b]) => at > a && at < b);
      const guardedBefore = WIN32_GUARD_RE.test(code.slice(0, at));
      if (!insideDarwin && !guardedBefore) {
        offenders.push(`${fn.name}: ${m[0]} (unguarded)`);
        break;
      }
    }
  }

  it('every AppleScript / mac-CLI call is behind a darwin block or a win32 guard', () => {
    expect(offenders).toEqual([]);
  });

  it('the restored win32 tools have an explicit win32 branch', () => {
    const must = [
      'readScreen', 'getActiveWindow', 'getWindows', 'focusWindow', 'openApp',
      'typeText', 'keyPress', 'mouseClick', 'mouseDrag', 'mouseScroll', 'clickPhysical',
      'readClipboard', 'writeClipboard', 'mouseDoubleClick', 'mouseRightClick',
      'mouseHover', 'getFocusedElement', 'desktopScreenshot', 'captureAndOcr',
    ];
    const missing = must.filter((name) => {
      const fn = fns.find((f) => f.name === name);
      return !fn || !/process\.platform (===|!==) '(win32|darwin)'/.test(fn.body);
    });
    expect(missing).toEqual([]);
  });
});
