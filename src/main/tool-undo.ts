/**
 * Inverse registry — declares how to undo each destructive tool call.
 *
 * For each undoable tool, TOOL_UNDO maps tool name → a factory that receives
 * (args, result) and returns an InverseAction (or null when the tool result
 * makes the inverse impossible to construct).
 *
 * Design rules:
 *   - When in doubt, return a `noop` with an honest reason. Never mark
 *     something undoable that isn't — the bad case is claiming success when
 *     we didn't actually undo.
 *   - The factory is allowed to read from `args._*` side-channel fields that
 *     the tool implementation smuggles in (e.g. the trash path written by
 *     the delete_file wrapper in tools.ts).
 *   - This module is pure: no I/O, no Electron imports. Testable in isolation.
 *
 * Adding a new undoable tool:
 *   1. Add it here.
 *   2. If the tool needs pre-capture (clipboard previous value, original file
 *      contents), add a withPreCapture wrapper in tools.ts around the
 *      tool's dispatch. See the delete_file / write_clipboard notes below.
 */

import type { InverseAction } from './action-history';
import type { ToolResult } from './types/tool-result';

export const TOOL_UNDO: Record<
  string,
  (args: Record<string, unknown>, result: ToolResult) => InverseAction | null
> = {
  // ── File operations ──────────────────────────────────────────────────────

  /**
   * write_file: inverse is restoring the file that was overwritten.
   * For v1 this is a noop because we don't capture the pre-write content
   * (that would require a read-before-write on every write_file call, which
   * is expensive and complicates the dispatch path). Document the limitation
   * honestly so users aren't surprised.
   *
   * Future: capture previous content in a withPreCapture wrapper and upgrade
   * to { kind: 'restore-file' } once the infrastructure is there.
   */
  write_file: (_args, _result) => ({
    kind: 'noop',
    reason: 'File written — previous content not captured (undo not available for writes).',
  }),

  /**
   * delete_file: inverse is restoring from ~/.clippy-trash/. The
   * delete_file implementation in tools.ts moves files to trash instead of
   * hard-deleting and smuggles the trash path via args._clippyTrashPath.
   * If that field is absent (older entry / error path), fall back to noop.
   */
  delete_file: (args, _result) => {
    const trashPath = String(args._clippyTrashPath ?? '');
    const originalPath = String(args.path ?? '');
    if (!trashPath || !originalPath) {
      return {
        kind: 'noop',
        reason: 'Trash path not recorded — file may have been hard-deleted.',
      };
    }
    return { kind: 'restore-file', trashPath, originalPath };
  },

  /**
   * rename_file: inverse is renaming back. args.from is the original name,
   * args.to is the new name. To undo, move args.to → args.from.
   */
  rename_file: (args, _result) => {
    const from = String(args.from ?? '');
    const to = String(args.to ?? '');
    if (!from || !to) return null;
    return { kind: 'rename', fromPath: to, toPath: from };
  },

  /**
   * move_file: same path as rename — POSIX rename handles cross-directory
   * moves. To undo, move back from the destination to the source.
   */
  move_file: (args, _result) => {
    const from = String(args.from ?? '');
    const to = String(args.to ?? '');
    if (!from || !to) return null;
    return { kind: 'move', fromPath: to, toPath: from };
  },

  // ── Calendar ─────────────────────────────────────────────────────────────

  /**
   * outlook_create_event: inverse is deleting the event. The Outlook COM
   * result doesn't expose an event ID in a machine-readable way today — it
   * returns a human-readable confirmation string. Mark as noop until we can
   * extract a stable entryId from the COM layer.
   */
  outlook_create_event: (_args, _result) => ({
    kind: 'noop',
    reason: 'Calendar event created via Outlook COM — event ID not captured, cannot auto-delete.',
  }),

  /**
   * create_calendar_event (generic / Apple Calendar path): tries to extract
   * eventId from the tool result object. Falls back to noop if absent.
   */
  create_calendar_event: (_args, result) => {
    const eventId = (result as { eventId?: string }).eventId;
    if (!eventId) {
      return {
        kind: 'noop',
        reason: 'Calendar event created — event ID not captured in result.',
      };
    }
    return { kind: 'delete-calendar-event', provider: 'apple', eventId };
  },

  // ── Email ────────────────────────────────────────────────────────────────

  /**
   * Email send is always a noop — cannot un-send an email. The reason is
   * shown as a tooltip on the greyed-out badge in the Activity panel.
   */
  outlook_send_email: () => ({
    kind: 'noop',
    reason: 'Email was sent via Outlook — cannot un-send.',
  }),

  outlook_web_send_email: () => ({
    kind: 'noop',
    reason: 'Email was sent via Outlook Web — cannot un-send.',
  }),

  gmail_web_send_email: () => ({
    kind: 'noop',
    reason: 'Email was sent via Gmail — cannot un-send.',
  }),

  // ── Clipboard ────────────────────────────────────────────────────────────

  /**
   * write_clipboard: inverse is restoring the previous clipboard value.
   * The dispatch wrapper in tools.ts attempts to capture the previous value
   * before overwriting and smuggles it via args._previousClipboard. If absent
   * (older entry / capture failed), fall back to noop.
   */
  write_clipboard: (args, _result) => {
    // _previousClipboard may be a string or null (empty clipboard).
    // The key's presence (even === null) means we captured it.
    if (!Object.prototype.hasOwnProperty.call(args, '_previousClipboard')) {
      return {
        kind: 'noop',
        reason: 'Clipboard overwritten — previous value not captured.',
      };
    }
    const previous = args._previousClipboard as string | null;
    return { kind: 'restore-clipboard', previousValue: previous };
  },

  // ── GitHub ───────────────────────────────────────────────────────────────

  /**
   * github_create_issue: would need to delete via the GitHub API. We don't
   * have a delete_issue tool yet and GitHub issues can't be truly deleted by
   * non-admins (only closed). Mark noop for now.
   */
  github_create_issue: () => ({
    kind: 'noop',
    reason: 'GitHub issue created — issues cannot be deleted via the public API.',
  }),

  // ── Excel (COM write) ────────────────────────────────────────────────────

  /**
   * excel_write: no undo without capturing the previous cell values. Noop
   * for v1 — future version can diff before/after.
   */
  excel_write: () => ({
    kind: 'noop',
    reason: 'Spreadsheet cells written — previous values not captured.',
  }),
};
