import { describe, it, expect } from 'vitest';
import { makeReceipt, blockedReceipt } from '../src/main/receipt';
import {
  toolVerdict, isPlainDone, shouldRecordWorkflow, typedTextLanded, UNCONFIRMED_COPY,
} from '../src/main/tool-verdict';

describe('toolVerdict — receipt drives the success decision when present', () => {
  it('verified receipt → ok + verified, even if the text looks error-shaped', () => {
    const v = toolVerdict({ text: '(weird but ran)', receipt: makeReceipt('focus_window', 'verified', true) });
    expect(v).toMatchObject({ ok: true, verified: true, receiptStatus: 'verified' });
  });

  it('unverified receipt → ok but NOT verified', () => {
    const v = toolVerdict({ text: 'Pasted 313 chars (NOT verified)', receipt: makeReceipt('type_text', 'unverified', true) });
    expect(v).toMatchObject({ ok: true, verified: false, receiptStatus: 'unverified' });
  });

  it('error / blocked / stale receipts → not ok, even with cheerful text', () => {
    for (const status of ['error', 'stale'] as const) {
      const v = toolVerdict({ text: 'Launched notepad', receipt: makeReceipt('open_app', status, true) });
      expect(v.ok).toBe(false);
      expect(v.verified).toBe(false);
    }
    expect(toolVerdict({ text: 'Clicked', receipt: blockedReceipt('smart_click', 'policy') }).ok).toBe(false);
  });

  it('falls back to the text-prefix heuristic for receipt-less tools', () => {
    expect(toolVerdict({ text: 'Pressed: ctrl+s' })).toEqual({ ok: true, verified: false });
    expect(toolVerdict({ text: '(error:UI_NOT_FOUND) nope' })).toEqual({ ok: false, verified: false });
    expect(toolVerdict({ text: 'Error: boom' })).toEqual({ ok: false, verified: false });
    expect(toolVerdict({ text: '' })).toEqual({ ok: true, verified: false });
  });
});

describe('typedTextLanded — readback tail compare', () => {
  it('matches when the field ends with what we pasted (CRLF/LF and trailing whitespace normalised)', () => {
    expect(typedTextLanded('hello\r\nworld', 'earlier text\nhello\nworld\n')).toBe(true);
    expect(typedTextLanded('hello', 'hello')).toBe(true);
  });
  it('compares only the last 64 chars so long pastes into long documents verify', () => {
    const text = 'x'.repeat(500) + 'the end';
    expect(typedTextLanded(text, 'doc prefix ' + text.slice(-100))).toBe(true);
  });
  it('rejects mismatches and missing readbacks', () => {
    expect(typedTextLanded('hello', 'hell')).toBe(false);
    expect(typedTextLanded('hello', null)).toBe(false);
    expect(typedTextLanded('hello', undefined)).toBe(false);
    expect(typedTextLanded('   ', '   ')).toBe(false);
  });
});

describe('isPlainDone', () => {
  it('catches content-free closers', () => {
    for (const t of ['Done', 'done!', 'All done.', 'Finished', 'Task completed', ' Complete ']) expect(isPlainDone(t)).toBe(true);
  });
  it('leaves real summaries alone', () => {
    for (const t of ['Done — pasted the summary into Notepad', 'Email sent!', 'I could not find the button']) expect(isPlainDone(t)).toBe(false);
  });
  it('exports the same honest copy the hallucination guard speaks', () => {
    expect(UNCONFIRMED_COPY).toMatch(/couldn't confirm/);
  });
});

describe('shouldRecordWorkflow — memory gating (plan §1.2)', () => {
  const base = {
    taskCompleted: true,
    abortReason: null,
    unconfirmed: false,
    activeProcess: 'notepad',
    successfulActionCount: 3,
    destructiveAttempts: [{ failed: false }],
    verifiedSteps: 1,
  };

  it('records a clean, verified task', () => {
    expect(shouldRecordWorkflow(base)).toBe(true);
  });

  it('refuses when every step is unverified (no verified receipt)', () => {
    expect(shouldRecordWorkflow({ ...base, verifiedSteps: 0 })).toBe(false);
  });

  it('refuses when the hallucination guard flagged the task', () => {
    expect(shouldRecordWorkflow({ ...base, unconfirmed: true })).toBe(false);
  });

  it('refuses when any destructive attempt failed', () => {
    expect(shouldRecordWorkflow({ ...base, destructiveAttempts: [{ failed: false }, { failed: true }] })).toBe(false);
  });

  it('keeps the pre-existing conditions (completed, no abort, app known, ≥2 actions)', () => {
    expect(shouldRecordWorkflow({ ...base, taskCompleted: false })).toBe(false);
    expect(shouldRecordWorkflow({ ...base, abortReason: 'max_steps' })).toBe(false);
    expect(shouldRecordWorkflow({ ...base, activeProcess: '' })).toBe(false);
    expect(shouldRecordWorkflow({ ...base, successfulActionCount: 1 })).toBe(false);
  });
});
