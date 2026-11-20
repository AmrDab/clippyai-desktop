/**
 * 0.24.12 audit #6: the Guardrails activity log is built without innerHTML,
 * and the Settings page no longer allows inline script.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildHistoryRow, undoneBadge, type DocLike, type ElLike, type HistoryRow } from '../src/renderer/history-row';

class FakeEl implements ElLike {
  className = '';
  textContent: string | null = null;
  style = { cssText: '' };
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  constructor(public tag: string) {}
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  appendChild(child: ElLike): unknown { this.children.push(child as FakeEl); return child; }
  /** innerHTML must never be assigned. */
  set innerHTML(_v: string) { throw new Error('innerHTML assigned'); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const doc: DocLike = { createElement: (tag) => new FakeEl(tag) };
const rel = () => '2m ago';

const base: HistoryRow = { id: 'a1', ts: '2026-11-20T10:00:00Z', tool: 'write_file', tier: 2, actionClass: 'destructive_file', outcome: 'success', detail: 'Wrote notes.txt' };
const build = (over: Partial<HistoryRow> = {}) => {
  const { row, undoButton } = buildHistoryRow(doc, { ...base, ...over }, rel);
  return { row: row as FakeEl, undoButton: undoButton as FakeEl | null };
};
const texts = (row: FakeEl) => row.all().map((e) => e.textContent).filter((t): t is string => !!t);

describe('activity log row', () => {
  it('shows tool, class, detail and time', () => {
    const { row } = build();
    expect(row.className).toBe('action-row');
    expect(texts(row)).toEqual(expect.arrayContaining(['write_file', '·destructive_file·T2', 'Wrote notes.txt', '2m ago', '✓']));
  });

  it('a detail with a quote and markup stays text: nothing breaks out of the title attribute', () => {
    const payload = 'x" onmouseover="alert(1)" a="<img src=x onerror=alert(2)>';
    const { row } = build({ detail: payload, tool: '<b>tool</b>' });
    const all = row.all();
    const detailEl = all.find((e) => e.textContent === payload)!;
    expect(detailEl).toBeTruthy();
    expect(detailEl.attrs.title).toBe(payload);
    // Only the fixed tags exist, and the only attributes are title / data-id.
    expect(new Set(all.map((e) => e.tag))).toEqual(new Set(['div', 'span']));
    for (const e of all) expect(Object.keys(e.attrs).every((k) => k === 'title' || k === 'data-id')).toBe(true);
    expect(all.some((e) => e.textContent === '<b>tool</b>')).toBe(true);
  });

  it('receipt reason and noop reason go into title attributes as plain text', () => {
    const evil = '"><script>alert(1)</script>';
    const { row } = build({
      receipt: { status: 'blocked', executed: false, execution_path: evil, evidence: { reason: evil } },
      inverse: { kind: 'noop', reason: evil },
    });
    const all = row.all();
    const pill = all.find((e) => e.textContent === 'blocked')!;
    expect(pill.attrs.title).toBe(`blocked: did not run via ${evil} — ${evil}`);
    const noop = all.find((e) => e.className === 'undo-badge undo-noop')!;
    expect(noop.attrs.title).toBe(evil);
    expect(noop.textContent).toBe("Can't undo");
  });

  it('an unknown receipt status cannot inject a style: it falls back to the stale palette', () => {
    const { row } = build({ receipt: { status: 'x;background:url(https://a.example/)', executed: null, evidence: {} } });
    const pill = row.all().find((e) => e.textContent === 'x;background:url(https://a.example/)')!;
    expect(pill.style.cssText).toContain('background:#f3f4f6');
    expect(pill.style.cssText).not.toContain('url(');
    const proto = build({ receipt: { status: 'constructor', executed: null, evidence: {} } });
    expect(proto.row.all().find((e) => e.textContent === 'constructor')!.style.cssText).toContain('background:#f3f4f6');
  });

  it('an undoable entry gets an Undo button carrying the id; others do not', () => {
    const { undoButton } = build({ inverse: { kind: 'restore-file' }, id: 'row"7' });
    expect(undoButton?.tag).toBe('button');
    expect(undoButton?.className).toBe('undo-btn');
    expect(undoButton?.attrs['data-id']).toBe('row"7');
    expect(build().undoButton).toBeNull();
    expect(build({ inverse: { kind: 'noop' } }).undoButton).toBeNull();
    const undone = build({ inverse: { kind: 'restore-file' }, undone: true, undoneAt: '2026-11-20T10:05:00Z' });
    expect(undone.undoButton).toBeNull();
    expect(undone.row.all().some((e) => e.className === 'undo-badge undo-done' && e.textContent === 'Undone')).toBe(true);
    expect((undoneBadge(doc, 'not a date') as FakeEl).attrs.title).toBeUndefined();
  });
});

describe('Settings page hardening', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'), 'utf8');
  const ts = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.ts'), 'utf8');

  it("script-src has no 'unsafe-inline'", () => {
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)![1];
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).toBe("script-src 'self'");
  });

  it('the page has no inline script or inline event handler', () => {
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(ts).not.toMatch(/\son(?:click|change|input|error|load|mouseover)\s*=\s*\\?["']/i);
  });

  it('the activity log and the update-failed status no longer build HTML from data', () => {
    expect(ts).toContain('buildHistoryRow(document, r, fmtRelTime)');
    expect(ts).not.toContain('title="${escDetail}"');
    expect(ts).not.toContain('<a href="${manualUrl}"');
  });
});
