/**
 * tool-undo.ts — TOOL_UNDO registry.
 *
 * v0.19.0 — PR-5 mac mirror: undo + action log surface.
 *
 * Each entry maps a tool name to a factory function:
 *   (args, result) => InverseAction | null
 *
 * Return null to suppress the Undo button (e.g. when the operation wasn't
 * actually executed or the result already captures failure). Return a
 * { kind: 'noop', reason } to show a greyed "Can't undo" badge.
 *
 * Fail-closed: any tool NOT in this map has no Undo button.
 *
 * Mac port notes (v0.19.0):
 *   - write_clipboard uses Electron clipboard API (not PowerShell Get-Clipboard)
 *     so the previous text is captured via clipboard.readText() in tools.ts
 *     and kept in memory here (rememberClipboard); only a reference reaches
 *     the history file.
 *   - delete_file uses fs.renameSync to ~/.clippy-trash (POSIX-compatible).
 *   - rename_file / move_file swap from/to for undo.
 *   - Apple Mail / Mac-specific tools not added yet (fail-closed = no Undo button).
 */

import type { InverseAction } from './action-history';
import type { ToolResult } from './types/tool-result';

// Previous clipboard text for the write_clipboard undo. Memory only: it is
// never written to action-history.json or a log, and is gone when Clippy
// quits (the undo then says so). Small ring so it cannot grow.
const CLIPBOARD_MEMORY_MAX = 20;
const clipboardMemory = new Map<string, string>();
let clipboardSeq = 0;

/** Keep `text` in memory; returns the reference to store in the history entry. */
export function rememberClipboard(text: string): string {
  const ref = `clip-${Date.now().toString(36)}-${++clipboardSeq}`;
  clipboardMemory.set(ref, text);
  while (clipboardMemory.size > CLIPBOARD_MEMORY_MAX) {
    const oldest = clipboardMemory.keys().next().value;
    if (oldest === undefined) break;
    clipboardMemory.delete(oldest);
  }
  return ref;
}

/** The remembered text for `ref` (removed once taken), or undefined. */
export function takeClipboard(ref: string): string | undefined {
  const text = clipboardMemory.get(ref);
  clipboardMemory.delete(ref);
  return text;
}

type ToolUndoFactory = (
  args: Record<string, unknown>,
  result: ToolResult,
) => InverseAction | null;

export const TOOL_UNDO: Record<string, ToolUndoFactory> = {
  // ── File operations ──────────────────────────────────────────────────────

  write_file: (_args, _result): InverseAction => ({
    kind: 'noop',
    reason: 'write_file does not capture the previous content. Use version control to recover the old file.',
  }),

  delete_file: (args, _result): InverseAction | null => {
    const trashPath = args._clippyTrashPath as string | undefined;
    const originalPath = (args.path ?? args.file_path) as string | undefined;
    if (!trashPath || !originalPath) {
      // File was not moved to trash (e.g. it didn't exist); suppress Undo button.
      return null;
    }
    return { kind: 'restore-file', trashPath, originalPath };
  },

  rename_file: (args, _result): InverseAction | null => {
    const from = (args.from ?? args.source ?? args.old_path) as string | undefined;
    const to = (args.to ?? args.destination ?? args.new_path) as string | undefined;
    if (!from || !to) return null;
    // Undo = rename back (swap from/to)
    return { kind: 'rename', from: to, to: from };
  },

  move_file: (args, _result): InverseAction | null => {
    const from = (args.from ?? args.source ?? args.old_path) as string | undefined;
    const to = (args.to ?? args.destination ?? args.new_path) as string | undefined;
    if (!from || !to) return null;
    // Undo = move back (swap from/to)
    return { kind: 'move', from: to, to: from };
  },

  // ── Calendar / email ─────────────────────────────────────────────────────

  outlook_create_event: (_args, result): InverseAction => {
    // The result text may contain the eventId if the tool returns it
    const eventIdMatch = result.text?.match(/EventId[:\s]+([^\s,]+)/i);
    const eventId = eventIdMatch?.[1];
    if (eventId) return { kind: 'delete-calendar-event', eventId };
    return { kind: 'noop', reason: 'Event ID not captured in result; delete manually from calendar.' };
  },

  outlook_send_email: (_args, _result): InverseAction => ({
    kind: 'noop',
    reason: 'Emails cannot be recalled after sending.',
  }),

  outlook_web_send_email: (_args, _result): InverseAction => ({
    kind: 'noop',
    reason: 'Emails cannot be recalled after sending.',
  }),

  gmail_web_send_email: (_args, _result): InverseAction => ({
    kind: 'noop',
    reason: 'Emails cannot be recalled after sending.',
  }),

  // ── Clipboard ────────────────────────────────────────────────────────────

  write_clipboard: (args, _result): InverseAction => {
    const clipRef = args._previousClipboardRef as string | null | undefined;
    if (typeof clipRef === 'string' && clipRef) {
      return { kind: 'restore-clipboard', clipRef };
    }
    return { kind: 'noop', reason: 'Previous clipboard content was not captured.' };
  },

  // ── Web / API ────────────────────────────────────────────────────────────

  github_create_issue: (_args, _result): InverseAction => ({
    kind: 'noop',
    reason: 'GitHub issues cannot be deleted via API; close it manually.',
  }),

  // ── Spreadsheet ──────────────────────────────────────────────────────────

  excel_write: (_args, _result): InverseAction => ({
    kind: 'noop',
    reason: 'excel_write does not capture the previous cell values. Use Excel Undo (Ctrl+Z) or version history.',
  }),
};
