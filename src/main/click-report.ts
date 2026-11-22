/**
 * click-report.ts — what smart_click tells the model after a UIA click.
 *
 * It used to say `Clicked "High" via UIA Select` whatever happened; a WinForms
 * combo box took the Select call and recorded nothing, and the model went on
 * as if the value were set. Now the script reads the control back and lists
 * what changed around it (smart-find.ps1), and every result ends with one line:
 *
 *   [confirmed]                      the state read back proves it
 *   [unverified · hint]              clicked; nothing proves the effect
 *   [failed · CODE · hint]           it did not happen
 *
 * Pure (no Electron) so it unit-tests.
 */
import type { ReceiptStatus } from './receipt';

export type Outcome = 'confirmed' | 'unverified' | 'failed';

/** The last line of an action result. */
export function outcomeLine(outcome: Outcome, code?: string, hint?: string): string {
  return `[${[outcome, code, hint].filter(Boolean).join(' · ')}]`;
}

export interface UiaClick {
  name: string;
  controlType: string;
  method: string;
  pending?: boolean;
  /** Win32 / WinForms list item, combo box or menu: real click, patterns skipped. */
  classic?: boolean;
  /** The control's state before / after: `unchecked`, `selected`, `collapsed = "Low"`… */
  before?: string | null;
  after?: string | null;
  /** The control is no longer there (a list that closed, a dialog that went away). */
  gone?: boolean;
  /** Windows opened/closed, new focus, the control's own change. Absent from an old script. */
  changed?: string[];
  /** A classic combo box's list item: the combo's value read back after the click (null = unreadable). */
  comboValue?: string | null;
}

export interface ClickReport {
  text: string;
  status: Extract<ReceiptStatus, 'verified' | 'unverified' | 'error'>;
  /** Failure code when status is 'error'. */
  code?: string;
}

const METHOD_LABEL: Record<string, string> = {
  'uia-invoke': 'Invoke', 'uia-toggle': 'Toggle', 'uia-select': 'Select',
  'uia-legacy': 'default action', 'uia-coords': 'click at the element centre', 'uia-setvalue': 'ValuePattern',
};
export const uiaMethodLabel = (method: string): string => METHOD_LABEL[method] ?? method;

const toggleWord = (s: string | null | undefined): string => /\b(unchecked|checked|mixed)\b/.exec(s ?? '')?.[1] ?? '';

export function reportUiaClick(target: string, r: UiaClick): ClickReport {
  const how = r.classic ? 'with a real click (classic control, UIA patterns skipped)' : `via UIA ${uiaMethodLabel(r.method)}`;
  const head = `Clicked "${target}" ${how} (${r.controlType} "${r.name}")`;
  const changed = (r.changed ?? []).filter((c) => typeof c === 'string' && c.trim());
  const changedLine = changed.length ? `\nChanged: ${changed.join('; ')}` : '';
  const done = (extra: string, status: ClickReport['status'], line: string, code?: string): ClickReport =>
    ({ text: `${head}${extra}${changedLine}\n${line}`, status, ...(code ? { code } : {}) });

  if (r.pending) {
    return done(' — the app is still handling it (a dialog may have opened)', 'unverified', outcomeLine('unverified', undefined, 'read_screen to see what opened'));
  }
  const readBack = typeof r.after === 'string' && typeof r.before === 'string';
  if (!r.classic && readBack && !r.gone && r.method === 'uia-toggle') {
    const now = toggleWord(r.after);
    if (r.after !== r.before) return done(now ? `: now ${now}` : '', 'verified', outcomeLine('confirmed'));
    return done(`, but it is still ${now || 'the same'}`, 'error',
      outcomeLine('failed', 'DID_NOTHING', 'the control did not change; click it with mouse_click, or focus it and key_press space'), 'DID_NOTHING');
  }
  if (!r.classic && readBack && !r.gone && r.method === 'uia-select') {
    if (/\bselected\b/.test(r.after ?? '')) return done(': now selected', 'verified', outcomeLine('confirmed'));
    return done(', but it is still not selected', 'error',
      outcomeLine('failed', 'DID_NOTHING', 'the control did not change; click it with mouse_click'), 'DID_NOTHING');
  }
  if (r.classic && r.comboValue !== undefined) {
    const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
    if (r.comboValue !== null && norm(r.comboValue) === norm(r.name)) {
      return done(`: the list now shows "${r.comboValue}"`, 'verified', outcomeLine('confirmed'));
    }
    if (r.comboValue !== null) {
      return done(`, but the list still shows "${r.comboValue}"`, 'error',
        outcomeLine('failed', 'DID_NOTHING', `focus the list box, type the first letters of "${r.name}" and press enter, then read_screen`), 'DID_NOTHING');
    }
  }
  if (changed.length) return done('', 'unverified', outcomeLine('unverified', undefined, 'the screen changed as listed; read_screen if the result matters'));
  if (r.changed) return done('', 'unverified', outcomeLine('unverified', 'NO_VISIBLE_CHANGE', 'nothing visible changed; read_screen to check before going on'));
  return done('', 'unverified', outcomeLine('unverified', undefined, 'read_screen to check'));
}
