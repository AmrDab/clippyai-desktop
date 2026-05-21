/**
 * Undo executor — applies an InverseAction to reverse a tool call.
 *
 * This module is the ONLY place undo logic lives. It imports no UI code and
 * can be unit-tested in isolation. Each branch must be conservative:
 *
 *   - On error: log, return { ok: false, detail: errMsg }. Never claim success
 *     when we're unsure — that destroys trust more than an honest failure.
 *   - On 'noop': return { ok: false, detail: inv.reason } — not an error, just
 *     "this action was marked not-undoable at record time".
 *
 * Called from ipc.ts `action-undo` handler. The handler owns the
 * findById / markUndone calls; this module just applies the mechanical inverse.
 */

import fs from 'fs';
import { createLogger } from './logger';
import type { InverseAction } from './action-history';

const log = createLogger('Undo');

export interface UndoResult {
  ok: boolean;
  detail?: string;
}

/**
 * Apply an InverseAction. Returns { ok, detail }.
 * Errors are caught here and surfaced as { ok: false }.
 */
export async function applyInverse(inv: InverseAction): Promise<UndoResult> {
  try {
    switch (inv.kind) {

      case 'restore-file': {
        // Move trashPath back to originalPath.
        // Guard: trashPath must exist; originalPath must not (to avoid
        // silent overwrites of files the user created after the delete).
        if (!inv.trashPath || !inv.originalPath) {
          return { ok: false, detail: 'restore-file: missing trashPath or originalPath.' };
        }
        if (!fs.existsSync(inv.trashPath)) {
          return { ok: false, detail: `restore-file: trash path does not exist: ${inv.trashPath}` };
        }
        if (fs.existsSync(inv.originalPath)) {
          return {
            ok: false,
            detail: `restore-file: a file already exists at the original path (${inv.originalPath}) — refusing to overwrite.`,
          };
        }
        fs.renameSync(inv.trashPath, inv.originalPath);
        log.info('Undo restore-file', { from: inv.trashPath, to: inv.originalPath });
        return { ok: true, detail: `Restored: ${inv.originalPath}` };
      }

      case 'rename': {
        // Rename fromPath back to toPath (fromPath = new name, toPath = old name).
        if (!inv.fromPath || !inv.toPath) {
          return { ok: false, detail: 'rename: missing fromPath or toPath.' };
        }
        if (!fs.existsSync(inv.fromPath)) {
          return { ok: false, detail: `rename: file not found at new path: ${inv.fromPath}` };
        }
        fs.renameSync(inv.fromPath, inv.toPath);
        log.info('Undo rename', { from: inv.fromPath, to: inv.toPath });
        return { ok: true, detail: `Renamed back: ${inv.fromPath} → ${inv.toPath}` };
      }

      case 'move': {
        // Move fromPath back to toPath (same as rename on POSIX — fs.renameSync
        // handles cross-directory moves on the same volume).
        if (!inv.fromPath || !inv.toPath) {
          return { ok: false, detail: 'move: missing fromPath or toPath.' };
        }
        if (!fs.existsSync(inv.fromPath)) {
          return { ok: false, detail: `move: file not found at destination: ${inv.fromPath}` };
        }
        fs.renameSync(inv.fromPath, inv.toPath);
        log.info('Undo move', { from: inv.fromPath, to: inv.toPath });
        return { ok: true, detail: `Moved back: ${inv.fromPath} → ${inv.toPath}` };
      }

      case 'delete-calendar-event': {
        // Delegate to the delete tool via executeTool. Dynamic import to avoid
        // a circular dependency (tools.ts → undo.ts would be circular).
        const { executeTool } = await import('./tools');
        const result = await executeTool('delete_calendar_event', { id: inv.eventId });
        const ok = !result.text.startsWith('(error:');
        log.info('Undo delete-calendar-event', { eventId: inv.eventId, ok, result: result.text.substring(0, 100) });
        return { ok, detail: result.text.substring(0, 200) };
      }

      case 'delete-email-draft': {
        // Draft deletion — provider-specific. Noop for v1 until draft tools exist.
        log.warn('Undo delete-email-draft: not implemented', { provider: inv.provider, draftId: inv.draftId });
        return { ok: false, detail: `delete-email-draft undo not implemented for provider: ${inv.provider}` };
      }

      case 'restore-clipboard': {
        // Restore clipboard via Electron clipboard API.
        // Dynamic import: electron is only available in the main process.
        const { clipboard } = await import('electron');
        const text = inv.previousValue ?? '';
        clipboard.writeText(text);
        log.info('Undo restore-clipboard', { length: text.length });
        return {
          ok: true,
          detail: text
            ? `Clipboard restored (${text.length} chars)`
            : 'Clipboard cleared (was empty before)',
        };
      }

      case 'recreate-from-args': {
        // Generic fallback: re-run the original tool with original args.
        // Used for idempotent tools where "undo" means "re-apply the original
        // state" (e.g. writing a config file back to known-good content).
        const { executeTool } = await import('./tools');
        const result = await executeTool(inv.tool, inv.args);
        const ok = !result.text.startsWith('(error:');
        log.info('Undo recreate-from-args', { tool: inv.tool, ok, result: result.text.substring(0, 100) });
        return { ok, detail: result.text.substring(0, 200) };
      }

      case 'noop': {
        // Explicitly marked as not undoable at record time. Return ok:false
        // with the reason — the UI shows this as a greyed-out badge.
        return { ok: false, detail: inv.reason };
      }

      default: {
        // Exhaustiveness guard — TypeScript narrows the union, but this
        // protects against old history entries with unknown future kinds.
        const _never: never = inv;
        return { ok: false, detail: `Unknown inverse kind: ${(_never as InverseAction).kind}` };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('applyInverse threw', { kind: (inv as InverseAction).kind, err: msg });
    return { ok: false, detail: `Undo failed: ${msg}` };
  }
}
