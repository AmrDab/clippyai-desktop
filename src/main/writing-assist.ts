/**
 * writing-assist.ts — the "Clippy writing assistant" (⌥G) orchestration.
 *
 * Flow (v1):
 *   1. ⌥G fires (hotkey.ts) → triggerWritingAssist(mainWindow).
 *   2. Read the system-wide FOCUSED text field via the Swift bridge
 *      (macBridge.a11yFocused).
 *   3. Run the on-device Harper grammar engine (lintText) on its value.
 *   4. Apply each lint's first suggestion (applyLints) to get the corrected
 *      text.
 *   5. Pop a small glassy card near the field offering the corrected text +
 *      a one-click Apply (which writes the field back in place via
 *      macBridge.a11yFocusedSetValue, wired through ipc.ts).
 *
 * applyLints is a PURE function (no Electron, no bridge) so it's unit-tested
 * in isolation (tests/writing-assist.test.ts).
 *
 * STATIC imports only — this build tree-shakes dynamic imports.
 */

import type { BrowserWindow } from 'electron';
import { lintText } from './harper-lint';
import { createWritingCardWindow } from './window';
import * as macBridge from './mac-bridge-native';
import { BridgeError } from './mac-bridge-native';
import { createLogger } from './logger';

const log = createLogger('WritingAssist');

/** The minimal lint shape applyLints needs (a subset of harper-lint's LintResult). */
export interface ApplicableLint {
  start: number;
  end: number;
  suggestions: string[];
}

/**
 * Apply each lint's first NON-EMPTY suggestion to `original`, returning the
 * corrected string.
 *
 * Lints are processed sorted by `start` DESCENDING so that each splice happens
 * to the right of all not-yet-applied edits — the offsets of the remaining
 * (earlier) lints stay valid throughout. Lints whose first suggestion is empty
 * (or which have no suggestions) are skipped: Harper sometimes reports a
 * problem it can flag but not auto-fix, and we never want to delete text we
 * can't replace.
 *
 * Pure: no Electron, no bridge, no I/O. Unit-tested directly.
 */
export function applyLints(original: string, lints: ApplicableLint[]): string {
  // Copy before sorting so we don't mutate the caller's array.
  const ordered = [...lints].sort((a, b) => b.start - a.start);
  let result = original;
  for (const lint of ordered) {
    const replacement = lint.suggestions.find((s) => s.length > 0);
    if (replacement === undefined) continue; // no usable suggestion → leave as-is
    // Guard against bogus spans so a bad lint can't corrupt the whole string.
    if (lint.start < 0 || lint.end > result.length || lint.start > lint.end) continue;
    result = result.slice(0, lint.start) + replacement + result.slice(lint.end);
  }
  return result;
}

/** Payload sent to the card renderer once it finishes loading. */
export interface WritingAssistPayload {
  original: string;
  corrected: string;
  count: number;
  app: string;
}

/**
 * Read the focused field, lint it, and present a correction card near it.
 * Speaks through Clippy for the "nothing to do" / "looks clean" / "grant
 * permission" cases instead of opening an empty card.
 */
export async function triggerWritingAssist(mainWindow: BrowserWindow): Promise<void> {
  try {
    const [f, sel] = await Promise.all([
      macBridge.a11yFocused(),
      macBridge.a11ySelectedText().catch(() => ({ hasSelection: false, selectedText: '', length: 0, app: '', role: '' })),
    ]);

    // Prefer the current selection if it's meaningful (> 10 chars) — linting
    // the specific excerpt the user highlighted is far more useful than the
    // whole field.
    const useSelection = sel.hasSelection && sel.selectedText.trim().length > 10;
    const textToLint = useSelection ? sel.selectedText : (f.value ?? '');

    if (!textToLint.trim()) {
      log.info('No focused text to assist');
      mainWindow.webContents.send('clippy-speak', {
        text: 'Put your cursor in some text first 📎',
        animate: 'GestureUp',
      });
      return;
    }

    if (useSelection) log.info('Writing assist: linting selection', { chars: textToLint.length });

    const lints = await lintText(textToLint);
    if (lints.length === 0) {
      log.info('Focused text is clean', { app: f.app, length: textToLint.length });
      mainWindow.webContents.send('clippy-speak', {
        text: 'Looks clean to me! ✓',
        animate: 'Congratulate',
      });
      return;
    }

    const corrected = applyLints(textToLint, lints);
    log.info('Offering correction', { app: f.app, count: lints.length, selection: useSelection });

    const card = createWritingCardWindow(f.bounds);
    const payload: WritingAssistPayload = {
      original: textToLint,
      corrected,
      count: lints.length,
      app: f.app,
    };

    // The card may still be loading its HTML — send the payload only after
    // did-finish-load so the renderer's listener is registered. If it's
    // already loaded (reused singleton), send immediately.
    if (card.webContents.isLoading()) {
      card.webContents.once('did-finish-load', () => {
        if (!card.isDestroyed()) card.webContents.send('writing-assist:data', payload);
      });
    } else {
      card.webContents.send('writing-assist:data', payload);
    }
  } catch (err) {
    if (err instanceof BridgeError && err.kind === 'permission') {
      log.warn('Writing assist blocked — Accessibility not granted');
      mainWindow.webContents.send('clippy-speak', {
        text: 'I need Accessibility access to read and fix your text. Grant it in System Settings → Privacy & Security → Accessibility 📎',
        animate: 'GestureUp',
      });
      return;
    }
    log.error('Writing assist failed', { err: String(err) });
    mainWindow.webContents.send('clippy-speak', {
      text: "I couldn't read that text field, sorry! 📎",
      animate: 'GestureUp',
    });
  }
}
