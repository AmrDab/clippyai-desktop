/**
 * approval.ts — Phase 3 guardrails: the in-bubble "Can I …?" prompt.
 *
 * brain.ts calls requestApproval() when permission-policy.decide() says
 * 'approve'. Main sends `approval-request` to the renderer (bubble shows
 * Approve / Deny), the renderer answers via the `approval-response` IPC
 * (ipc.ts → resolveApproval). No answer within APPROVAL_TIMEOUT_MS = deny.
 * Anything that cancels the task (sleep, user override, takeover) calls
 * cancelAllApprovals() so no prompt outlives the task that asked.
 */

import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { createLogger, redactArgs } from './logger';
import type { ActionClass } from './tool-meta';

const log = createLogger('Approval');

export type ApprovalResult = 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface ApprovalRequest {
  tool: string;
  summary: string;
  actionClass: ActionClass;
}

export const APPROVAL_TIMEOUT_MS = 25_000;

const pending = new Map<string, { resolve: (r: ApprovalResult) => void; timer: ReturnType<typeof setTimeout> }>();

function finish(id: string, result: ApprovalResult): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  log.info('Approval.resolved', { id, result });
  p.resolve(result);
  return true;
}

/** Ask the user. Resolves 'denied' immediately if there is no window to ask in. */
export function requestApproval(win: BrowserWindow | null, req: ApprovalRequest): Promise<ApprovalResult> {
  if (!win || win.isDestroyed()) return Promise.resolve('denied');
  const id = randomUUID();
  return new Promise<ApprovalResult>((resolve) => {
    const timer = setTimeout(() => finish(id, 'timeout'), APPROVAL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    log.info('Approval.request', { id, tool: req.tool, class: req.actionClass });
    win.webContents.send('approval-request', { id, ...req });
  });
}

/** Renderer answered. Returns false for an unknown / already-settled id. */
export function resolveApproval(id: string, approved: boolean): boolean {
  return finish(id, approved ? 'approved' : 'denied');
}

/** Settle every pending prompt as 'cancelled' (task aborted / sleep). */
export function cancelAllApprovals(): void {
  for (const id of [...pending.keys()]) finish(id, 'cancelled');
}

// ── Approval record for tools that need to double-check consent ─────
// brain marks a call approved right after the user says yes; the tool
// implementation (install_skill) consumes the mark. One-shot so a later
// un-prompted call can't ride on an earlier yes.

const approved = new Set<string>();

function approvalKey(tool: string, args: Record<string, unknown>): string {
  const key = tool === 'install_skill' ? String(args.slug ?? '') : JSON.stringify(args ?? {});
  return `${tool}:${key}`;
}

export function markApproved(tool: string, args: Record<string, unknown>): void {
  approved.add(approvalKey(tool, args));
}

/** Consume (and return) a prior approval for `tool` + key (install_skill: slug). */
export function wasApproved(tool: string, key: string): boolean {
  return approved.delete(`${tool}:${key}`);
}

// ── Human summary shown in the bubble ───────────────────────────────

const s = (v: unknown, max = 60): string => String(v ?? '').substring(0, max);

export function summarizeArgs(tool: string, args: Record<string, unknown> = {}): string {
  switch (tool) {
    case 'kill_process': return `Kill ${s(args.name ?? args.procPid)}`;
    case 'http_request': {
      let target = s(args.url, 80);
      try { const u = new URL(String(args.url)); target = u.host + u.pathname; } catch { /* keep raw */ }
      return `${String(args.method ?? 'GET').toUpperCase()} ${target}`;
    }
    case 'write_file': return `Write ${String(args.content ?? '').length.toLocaleString()} chars to ${s(args.path, 80)}`;
    case 'delete_file': return `Delete ${s(args.path, 80)}`;
    case 'rename_file': return `Rename ${s(args.from)} to ${s(args.to)}`;
    case 'move_file': return `Move ${s(args.from)} to ${s(args.to)}`;
    case 'shell_exec': return `Run \`${s(args.command, 80)}\``;
    case 'cdp_evaluate': return 'Run JavaScript in the browser page';
    case 'clawd_task': return `Hand off desktop task: ${s(args.task)}`;
    case 'install_skill': return `Install skill ${s(args.slug)}`;
    case 'windows_service_control': return `${s(args.action ?? 'status')} service ${s(args.name)}`;
  }
  if (/_send_email$/.test(tool)) return `Email to ${s(args.to)}, subject ${s(args.subject)}`;
  if (tool.startsWith('skill__')) return `Run skill ${tool.slice('skill__'.length)}`;
  return `${tool} ${JSON.stringify(redactArgs(args))}`.substring(0, 120);
}
