/**
 * history-row.ts — one row of Settings → Guardrails → activity log.
 *
 * The row shows text that comes from tool calls (a file name, a window
 * title, an error message), which a web page or document can influence. It is
 * therefore built with createElement / textContent / setAttribute only: no
 * innerHTML, so nothing in a row can become markup (0.24.12 audit #6).
 *
 * Takes the document as a parameter so it is unit-tested without a browser.
 */

export interface HistoryRow {
  id: string;
  ts: string;
  tool: string;
  tier: number;
  actionClass: string | null;
  outcome: string;
  detail: string;
  inverse?: { kind: string; reason?: string; [key: string]: unknown };
  undone?: boolean;
  undoneAt?: string;
  receipt?: { status: string; executed: boolean | null; execution_path?: string; evidence: Record<string, unknown> };
}

/** The slice of Document / HTMLElement the builder uses. */
export interface ElLike {
  className: string;
  textContent: string | null;
  style: { cssText: string };
  setAttribute(name: string, value: string): void;
  appendChild(child: ElLike): unknown;
}
export interface DocLike {
  createElement(tag: string): ElLike;
}

function el(doc: DocLike, tag: string, css: string, text?: string, title?: string): ElLike {
  const e = doc.createElement(tag);
  if (css) e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  if (title !== undefined) e.setAttribute('title', title);
  return e;
}

function outcomeBadge(doc: DocLike, outcome: string): ElLike {
  const color = outcome === 'success' ? '#16a34a' : outcome === 'failure' ? '#dc2626' : outcome === 'blocked' ? '#9333ea' : '#d97706';
  const label = outcome === 'success' ? '✓' : outcome === 'failure' ? '✗' : outcome === 'blocked' ? '⊘' : '~';
  return el(doc, 'span', `display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:${color};color:#fff;font-size:9px;font-weight:700;flex-shrink:0;`, label, String(outcome));
}

const RECEIPT_PALETTE: Record<string, [string, string]> = {
  verified: ['#d1fae5', '#065f46'], unverified: ['#fef3c7', '#92400e'],
  blocked: ['#ede9fe', '#5b21b6'], error: ['#fee2e2', '#991b1b'], stale: ['#f3f4f6', '#6b7280'],
};

/** v0.21 — receipt pill: did the action run, and was the effect verified? */
function receiptBadge(doc: DocLike, receipt: NonNullable<HistoryRow['receipt']>): ElLike {
  // The colours come from the fixed palette, never from the receipt itself.
  const known = Object.prototype.hasOwnProperty.call(RECEIPT_PALETTE, receipt.status);
  const [bg, fg] = known ? RECEIPT_PALETTE[receipt.status] : RECEIPT_PALETTE.stale;
  const ran = receipt.executed === true ? 'ran' : receipt.executed === false ? 'did not run' : 'outcome unknown';
  const via = receipt.execution_path ? ` via ${receipt.execution_path}` : '';
  const reason = typeof receipt.evidence?.reason === 'string' ? ` — ${receipt.evidence.reason}` : '';
  return el(doc, 'span', `margin-left:6px;background:${bg};color:${fg};border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600;white-space:nowrap;cursor:help;`,
    String(receipt.status), `${receipt.status}: ${ran}${via}${reason}`);
}

const BADGE = 'border-radius:4px;padding:2px 7px;font-size:10.5px;white-space:nowrap;';

/** The green "Undone" pill (also shown right after a successful undo). */
export function undoneBadge(doc: DocLike, undoneAt?: string): ElLike {
  const b = el(doc, 'span', `background:#d1fae5;color:#065f46;font-weight:600;${BADGE}`, 'Undone');
  b.className = 'undo-badge undo-done';
  if (undoneAt) {
    const t = new Date(undoneAt);
    if (!Number.isNaN(t.getTime())) b.setAttribute('title', `Undone at ${t.toLocaleTimeString()}`);
  }
  return b;
}

/**
 * Build the row. `undoButton` is set when the entry can be undone; the caller
 * wires its click handler.
 */
export function buildHistoryRow(doc: DocLike, r: HistoryRow, fmtRelTime: (ts: string) => string): { row: ElLike; undoButton: ElLike | null } {
  const row = el(doc, 'div', 'display:grid;grid-template-columns:18px 1fr auto;gap:6px;padding:6px 10px;border-bottom:1px solid #eef0f3;align-items:start;');
  row.className = 'action-row';
  row.appendChild(outcomeBadge(doc, r.outcome));

  const mid = el(doc, 'div', 'overflow:hidden;');
  const head = el(doc, 'div', 'color:#1a1a1a;font-weight:600;font-size:11.5px;', String(r.tool));
  head.appendChild(el(doc, 'span', 'color:#888;margin-left:6px;font-size:10.5px;', r.actionClass ? `·${r.actionClass}·T${r.tier}` : `·T${r.tier}`));
  if (r.receipt) head.appendChild(receiptBadge(doc, r.receipt));
  mid.appendChild(head);
  const detail = String(r.detail || '');
  mid.appendChild(el(doc, 'div', 'color:#555;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', detail, detail));
  mid.appendChild(el(doc, 'div', 'color:#aaa;font-size:10px;margin-top:1px;', fmtRelTime(r.ts)));
  row.appendChild(mid);

  const right = el(doc, 'div', 'display:flex;align-items:center;gap:4px;');
  let undoButton: ElLike | null = null;
  if (r.undone) {
    right.appendChild(undoneBadge(doc, r.undoneAt));
  } else if (r.inverse && r.inverse.kind === 'noop') {
    const b = el(doc, 'span', `background:#f3f4f6;color:#9ca3af;font-weight:500;cursor:help;${BADGE}`, "Can't undo", String(r.inverse.reason || ''));
    b.className = 'undo-badge undo-noop';
    right.appendChild(b);
  } else if (r.inverse) {
    undoButton = el(doc, 'button', 'background:#fff;border:1px solid #d0d4da;border-radius:4px;padding:2px 8px;font-size:10.5px;cursor:pointer;color:#374151;white-space:nowrap;', 'Undo', 'Undo this action');
    undoButton.className = 'undo-btn';
    undoButton.setAttribute('data-id', String(r.id));
    right.appendChild(undoButton);
  } else {
    right.appendChild(el(doc, 'div', 'color:#888;font-size:10.5px;white-space:nowrap;', fmtRelTime(r.ts)));
  }
  row.appendChild(right);
  return { row, undoButton };
}
