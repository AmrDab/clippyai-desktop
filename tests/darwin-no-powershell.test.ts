import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Mirror of win32-no-osascript.test.ts for the other direction: no code path
 * reachable on darwin may spawn powershell.exe. The v0.21 converge found
 * smart_click / minimize_window / minimize_all_windows / show_desktop guarded
 * by `if (process.platform === 'darwin' && macBridge.isBridgeAvailable())`
 * and then falling through to PowerShell whenever the Swift bridge was missing
 * (or threw 'missing'/'platform'), plus navigate_browser's default-browser
 * registry lookup running on every platform.
 *
 * Static check over src/main/**\/*.ts: every `'powershell.exe'` spawn must be
 *   (a) inside an `if (process.platform === 'win32' ...) { ... }` block, or
 *   (b) preceded in its function by `if (process.platform !== 'win32')` that
 *       returns, or by an `if (process.platform === 'darwin') { ... }` block
 *       (no `&&` — a bridge-availability clause is exactly the fall-through
 *       bug) whose last statement is an unconditional return/throw, or
 *   (c) in a non-exported helper whose every in-file call is itself guarded
 *       by (a)/(b), sits on the win32 arm of a platform ternary, or is inside
 *       a helper that satisfies (c).
 */

const MAIN = path.join(__dirname, '..', 'src', 'main');
const PS_RE = /['"]powershell\.exe['"]/g;
const FN_RE = /^(export )?(?:async )?function (\w+)\s*\(/gm;
const WIN_IF_RE = /if \(process\.platform === 'win32'[^{]*\{/g;
const DARWIN_IF_RE = /if \(process\.platform === 'darwin'\) \{/g;
const EARLY_RE = /if \(process\.platform !== 'win32'\) (?:return\b|\{\s*return\b)/;

/** Blank out comments (keeping offsets) so prose mentioning powershell.exe doesn't count. */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^\s*\/\/.*$/gm, blank);
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

interface Fn { name: string; exported: boolean; start: number; end: number }

function splitFunctions(src: string): Fn[] {
  const starts = [...src.matchAll(FN_RE)].map((m) => ({ name: m[2], exported: !!m[1], start: m.index! }));
  return starts.map((s, i) => ({ ...s, end: i + 1 < starts.length ? starts[i + 1].start : src.length }));
}

/** [open, close] offsets of each block opened by a regex match ending in `{`. */
function blocks(src: string, re: RegExp, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of src.slice(from, to).matchAll(re)) {
    const open = from + m.index! + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { out.push([open, i]); break; }
    }
  }
  return out;
}

/** Last statement of the block is `return …;` / `throw …;` at statement start. */
function endsInExit(inner: string): boolean {
  const m = inner.match(/(?:^|([;{}]))\s*(?:return|throw)\b[^;]*;\s*$/);
  return !!m && (m.index === 0 || m[1] !== undefined);
}

function guardedAt(src: string, fn: Fn, at: number): boolean {
  if (blocks(src, WIN_IF_RE, fn.start, fn.end).some(([a, b]) => at > a && at < b)) return true;
  const before = src.slice(fn.start, at);
  if (EARLY_RE.test(before)) return true;
  return blocks(src, DARWIN_IF_RE, fn.start, at).some(([a, b]) => b < at && endsInExit(src.slice(a + 1, b)));
}

function onWin32TernaryArm(src: string, at: number): boolean {
  const stmt = src.slice(Math.max(0, src.lastIndexOf(';', at - 1) + 1), at);
  return /platform === 'win32'\s*\?[\s([]*(?:await\s+)?$/.test(stmt)
    || /platform === 'darwin'\s*\?[^:]*:[\s([]*(?:await\s+)?$/.test(stmt);
}

function callerGated(src: string, fns: Fn[], fn: Fn, memo: Map<string, boolean>): boolean {
  if (memo.has(fn.name)) return memo.get(fn.name)!;
  memo.set(fn.name, false); // a recursion cycle counts as ungated
  const ok = !fn.exported && allCallsGated(src, fns, fn, memo);
  memo.set(fn.name, ok);
  return ok;
}

function allCallsGated(src: string, fns: Fn[], fn: Fn, memo: Map<string, boolean>): boolean {
  // Quoted strings blanked so a log message mentioning the name isn't a reference.
  const code = src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => ' '.repeat(m.length));
  const refs = [...code.matchAll(new RegExp(`\\b${fn.name}\\b`, 'g'))]
    .map((m) => m.index!)
    .filter((i) => i < fn.start || i > fn.start + 40); // skip the definition itself
  if (refs.length === 0) return false;
  return refs.every((i) => {
    if (src[i + fn.name.length] !== '(') return false; // passed by reference — can't trace
    const caller = fns.find((f) => i > f.start && i < f.end);
    if (!caller) return false;
    return guardedAt(src, caller, i) || onWin32TernaryArm(src, i) || callerGated(src, fns, caller, memo);
  });
}

describe('no darwin-reachable code spawns powershell.exe', () => {
  const offenders: string[] = [];
  let sites = 0;
  for (const file of files(MAIN)) {
    const src = stripComments(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    const fns = splitFunctions(src);
    for (const m of src.matchAll(PS_RE)) {
      sites++;
      const at = m.index!;
      const fn = fns.find((f) => at > f.start && at < f.end);
      const rel = path.relative(MAIN, file).replace(/\\/g, '/');
      if (!fn) { offenders.push(`${rel}: top-level powershell.exe`); continue; }
      if (guardedAt(src, fn, at) || onWin32TernaryArm(src, at) || callerGated(src, fns, fn, new Map())) continue;
      offenders.push(`${rel}: ${fn.name}`);
    }
  }

  it('finds the powershell.exe spawn sites', () => {
    expect(sites).toBeGreaterThan(30);
  });

  it('every powershell.exe spawn is unreachable on darwin', () => {
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('the guard logic rejects the bridge-availability fall-through shape', () => {
    const src = [
      'async function bad() {',
      "  if (process.platform === 'darwin' && macBridge.isBridgeAvailable()) {",
      "    try { return { text: 'ok' }; } catch { /* fall through */ }",
      '  }',
      "  await execFileAsync('powershell.exe', []);",
      '}',
      'async function good() {',
      "  if (process.platform === 'darwin') {",
      '    doThing();',
      '    return;',
      '  }',
      "  await execFileAsync('powershell.exe', []);",
      '}',
      'async function conditional() {',
      "  if (process.platform === 'darwin') {",
      '    if (x) return;',
      '  }',
      "  await execFileAsync('powershell.exe', []);",
      '}',
    ].join('\n');
    const fns = splitFunctions(src);
    const verdict = (name: string) => {
      const fn = fns.find((f) => f.name === name)!;
      return guardedAt(src, fn, src.indexOf("'powershell.exe'", fn.start));
    };
    expect(verdict('bad')).toBe(false);
    expect(verdict('good')).toBe(true);
    expect(verdict('conditional')).toBe(false);
  });
});
