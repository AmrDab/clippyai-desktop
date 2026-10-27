/**
 * receipt.ts — action receipts (v0.21).
 *
 * A receipt is the honest record of ONE primitive action: did we dispatch it,
 * did it run, and could we prove the effect. It is attached to the matching
 * action-history entry (ActionEntry.receipt) and shown as a badge in the
 * activity log. It is never sent to the server and never appended to the
 * tool-result text the model sees — the model's behaviour is unchanged.
 *
 * Contract (ported from plip-oss `Receipt` + `VerificationOutcome`, MIT,
 * Copyright (c) 2026 Hussain):
 *   - `task_complete` is ALWAYS false. A click that ran is not a task that
 *     finished; only the user's judgement (or a future verifier) can say so.
 *   - `executed` is tri-state: true = ran, false = never ran (blocked, denied,
 *     failed before dispatch), null = dispatched but we lost track (timeout).
 *   - status 'verified' needs evidence of the effect (write_file: size +
 *     sha256 of the file on disk match what we wrote). 'unverified' = it ran
 *     and nothing contradicts that, but nobody checked the outcome.
 */

import { createHash, randomUUID } from 'crypto';
import fsp from 'fs/promises';

export type ReceiptStatus = 'verified' | 'unverified' | 'blocked' | 'stale' | 'error';
export type VerificationOutcome = 'satisfied' | 'unsatisfied' | 'unknown';

export interface Receipt {
  action_id: string;
  tool: string;
  status: ReceiptStatus;
  /** true = ran, false = never ran, null = dispatched, outcome lost (timeout). */
  executed: boolean | null;
  /** Always false — a receipt proves an action, never a task. */
  task_complete: false;
  evidence: Record<string, unknown>;
  /** Which path executed it: 'uia' | 'ocr' | 'ax' | 'clawdcursor' | 'fs' … */
  execution_path?: string;
  /** ISO timestamp. */
  at: string;
}

export function makeReceipt(
  tool: string,
  status: ReceiptStatus,
  executed: boolean | null,
  evidence: Record<string, unknown> = {},
  execution_path?: string,
): Receipt {
  return {
    action_id: randomUUID(),
    tool,
    status,
    executed,
    task_complete: false,
    evidence,
    ...(execution_path ? { execution_path } : {}),
    at: new Date().toISOString(),
  };
}

/** Blocked by the Guardrails policy / governor, or denied at the approval prompt. */
export function blockedReceipt(tool: string, reason: string, extra: Record<string, unknown> = {}): Receipt {
  return makeReceipt(tool, 'blocked', false, { reason, ...extra });
}

/** Map a tri-state verification onto a receipt status. */
export function statusFromOutcome(outcome: VerificationOutcome): ReceiptStatus {
  return outcome === 'satisfied' ? 'verified' : 'error';
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface FileVerification {
  outcome: VerificationOutcome;
  evidence: Record<string, unknown>;
}

/**
 * Verify a write_file call after the fact: stat the file, hash what is on
 * disk, and compare with what we meant to write. For append mode only the
 * tail of the file is compared.
 *   satisfied   — size + sha256 match
 *   unsatisfied — file exists but differs (another writer, encoding, …)
 *   unknown     — could not read the file back
 */
export async function verifyWrittenFile(
  filePath: string,
  content: string,
  mode: 'create' | 'overwrite' | 'append',
): Promise<FileVerification> {
  const expectedBuf = Buffer.from(content, 'utf8');
  const expected = { bytes: expectedBuf.length, sha256: sha256(expectedBuf) };
  try {
    const [stat, onDisk] = await Promise.all([fsp.stat(filePath), fsp.readFile(filePath)]);
    const compared = mode === 'append' ? onDisk.subarray(Math.max(0, onDisk.length - expectedBuf.length)) : onDisk;
    const observed = { bytes: stat.size, sha256: sha256(compared) };
    const sizeOk = mode === 'append' ? stat.size >= expected.bytes : stat.size === expected.bytes;
    const ok = sizeOk && observed.sha256 === expected.sha256;
    return {
      outcome: ok ? 'satisfied' : 'unsatisfied',
      evidence: { path: filePath, mode, expected, observed },
    };
  } catch (err) {
    return {
      outcome: 'unknown',
      evidence: { path: filePath, mode, expected, error: err instanceof Error ? err.message : String(err) },
    };
  }
}
