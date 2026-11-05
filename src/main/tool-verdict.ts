/**
 * tool-verdict.ts — v0.23 "honest" success decisions for the agent loop.
 *
 * Pure: no Electron, no I/O. brain.ts used to decide a tool call failed iff
 * its text started with `(` or `error:` — so "Pasted 313 chars (NOT
 * verified)" counted as a success, got memorised as a recipe and let the
 * model say "Done". Receipts (receipt.ts) are now first-class: when a tool
 * returns one, its status drives the decision; the prefix heuristic stays as
 * the fallback for receipt-less tools.
 */

import type { ReceiptStatus } from './receipt';
import type { ToolResult } from './types/tool-result';

export interface ToolVerdict {
  /** The call ran and nothing says it failed (receipt verified/unverified, or non-error text). */
  ok: boolean;
  /** The tool PROVED its effect (receipt status 'verified'). Never true from text alone. */
  verified: boolean;
  receiptStatus?: ReceiptStatus;
}

export function looksLikeErrorText(text: string): boolean {
  return text.startsWith('(') || text.toLowerCase().startsWith('error:');
}

export function toolVerdict(result: Pick<ToolResult, 'text' | 'receipt'>): ToolVerdict {
  const r = result.receipt;
  if (r) {
    const ok = r.status === 'verified' || r.status === 'unverified';
    return { ok, verified: r.status === 'verified', receiptStatus: r.status };
  }
  return { ok: !looksLikeErrorText(result.text || ''), verified: false };
}

/**
 * type_text readback: did the tail of what we meant to paste land in the
 * focused field? Line endings and trailing whitespace are normalised (edit
 * controls rewrite CRLF/LF; UIA trims). Compares the last 64 chars so a long
 * paste into a long document still verifies.
 */
export function typedTextLanded(expected: string, readback: string | null | undefined): boolean {
  if (typeof readback !== 'string') return false;
  const norm = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const want = norm(expected).slice(-64);
  if (!want) return false;
  return norm(readback).endsWith(want);
}

/** A bare "Done!"-style closer with no content the user could check. */
export function isPlainDone(text: string): boolean {
  return /^\W*(done|all done|finished|completed|complete|all set|task complete[d]?)\W*$/i.test(text.trim());
}

/** The honest closer brain.ts speaks when it cannot vouch for the last step. */
export const UNCONFIRMED_COPY =
  "I did the steps, but couldn't confirm it actually went through. Want me to try a different approach, or check it yourself?";

export interface DestructiveAttemptLike {
  /** Receipt-less tools: the result text was error-shaped or carried failure words.
   *  Receipt tools: status error/blocked/stale. */
  failed: boolean;
}

export interface RecordWorkflowInput {
  taskCompleted: boolean;
  abortReason: string | null;
  /** The hallucination guard overrode the model's success claim. */
  unconfirmed: boolean;
  activeProcess: string;
  successfulActionCount: number;
  destructiveAttempts: DestructiveAttemptLike[];
  /** Steps whose receipt status was 'verified'. */
  verifiedSteps: number;
}

/**
 * v0.23 memory hygiene (plan §1.2): only a task that (i) the guard did not
 * flag, (ii) had no failed destructive attempt and (iii) proved at least one
 * step is worth memorising as "the proven path".
 */
export function shouldRecordWorkflow(i: RecordWorkflowInput): boolean {
  return i.taskCompleted
    && !i.abortReason
    && !i.unconfirmed
    && !!i.activeProcess
    && i.successfulActionCount >= 2
    && i.verifiedSteps >= 1
    && !i.destructiveAttempts.some((a) => a.failed);
}
