/**
 * undo.ts — applyInverse executor.
 *
 * v0.19.0 — PR-5 mac mirror: undo + action log surface.
 *
 * Accepts an InverseAction descriptor and applies the appropriate
 * reversal operation. Each kind maps to a concrete action:
 *
 *   restore-file        → fs.renameSync(trashPath → originalPath)
 *   rename              → fs.renameSync(from → to)
 *   move                → fs.renameSync(from → to)
 *   restore-clipboard   → clipboard.writeText(previousText)
 *   delete-calendar-event → executeTool('outlook_upcoming') + delete
 *   delete-email-draft  → not implemented (returns ok:false)
 *   recreate-from-args  → re-execute tool with same args
 *   noop                → returns ok:false with reason
 *
 * Mac-specific notes:
 *   - Uses import('electron').clipboard for clipboard restore (works natively).
 *   - All file ops use fs.renameSync (POSIX-compatible, atomic on same volume).
 */

import fs from 'fs';
import type { InverseAction } from './action-history';

export interface UndoResult {
  ok: boolean;
  detail?: string;
}

export async function applyInverse(inv: InverseAction): Promise<UndoResult> {
  switch (inv.kind) {
    case 'restore-file': {
      try {
        if (!fs.existsSync(inv.trashPath)) {
          return { ok: false, detail: `Trash file not found: ${inv.trashPath}` };
        }
        fs.renameSync(inv.trashPath, inv.originalPath);
        return { ok: true, detail: `Restored ${inv.originalPath}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'rename':
    case 'move': {
      try {
        if (!fs.existsSync(inv.from)) {
          return { ok: false, detail: `Source not found: ${inv.from}` };
        }
        fs.renameSync(inv.from, inv.to);
        return { ok: true, detail: `Moved ${inv.from} → ${inv.to}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'restore-clipboard': {
      try {
        const { clipboard } = await import('electron');
        clipboard.writeText(inv.previousText);
        return { ok: true, detail: 'Clipboard restored.' };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'delete-calendar-event': {
      // Mac: no Outlook COM. Surface a message to delete manually.
      return {
        ok: false,
        detail: `Calendar undo not available on macOS. Delete event "${inv.eventId}" manually from your calendar app.`,
      };
    }

    case 'delete-email-draft': {
      return { ok: false, detail: 'Email draft undo not implemented.' };
    }

    case 'recreate-from-args': {
      try {
        const { executeTool } = await import('./tools');
        const result = await executeTool(inv.tool, inv.args);
        return { ok: true, detail: result.text?.substring(0, 200) || 'Done.' };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'noop': {
      return { ok: false, detail: inv.reason };
    }

    default: {
      return { ok: false, detail: 'Unknown inverse action kind.' };
    }
  }
}
