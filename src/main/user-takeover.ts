/**
 * User-takeover detection. Watches the system for keyboard/mouse activity
 * DURING a Clippy task and fires a cancellation when the user starts to
 * drive the cursor or type themselves.
 *
 * Why this exists
 * ───────────────
 * Pre-v0.18.x Clippy would stubbornly continue a long task even after the
 * user grabbed the mouse and started clicking somewhere else. The
 * cancellation infrastructure existed (cancelRequested + abortAllInFlightTools
 * in brain.ts) but nothing watched for organic user input, so the cancel
 * only fired on explicit signals: setMode('sleep'), a new chat message,
 * or the agent finishing on its own.
 *
 * Detection signal
 * ────────────────
 * `powerMonitor.getSystemIdleTime()` (built-in Electron) returns seconds
 * since the LAST system-wide user input event. Polling it every 500ms
 * during a task gives us a noisy but accurate signal: if idle time
 * drops to 0 unexpectedly, *something* just produced an input event.
 *
 * The Clippy-vs-user disambiguation
 * ─────────────────────────────────
 * Clippy himself is one of the things that produces input events.
 * When `mouse_click`, `type_text`, `smart_type`, `cdp_type`, `key_press`,
 * etc. fire, they go through CGEventPost / AppleScript keystroke / Win32
 * SendInput — all of which reset the system idle timer. So a naive
 * "idle time dropped to 0 → user took over" check would fire on every
 * Clippy-initiated click.
 *
 * Solution: callers (the tool dispatcher) call `noteClippyInput()` BEFORE
 * and AFTER every input-generating tool dispatch. The monitor maintains
 * `lastClippyInputAt` and treats any idle reset within
 * `lastClippyInputAt + GRACE_WINDOW_MS` (1.5s) as Clippy-origin, ignored.
 * Outside that window, an idle reset is organic user activity.
 *
 * Voice STT gate
 * ──────────────
 * Whisper transcription synthesizes keystrokes via `type_text` when the
 * user finishes speaking. That's structurally a Clippy-input (the
 * `type_text` tool runs), so `noteClippyInput()` is already called on
 * the path. But if you're worried about a race where the user starts
 * typing WHILE Clippy is mid-speech-recognition (unlikely but possible),
 * call `pauseDetection()` for the duration of an active recording session.
 *
 * Hard-stop semantics
 * ───────────────────
 * When user takeover fires:
 *  1. The callback receives the reason ('user_takeover').
 *  2. The caller (brain.ts) sets `cancelRequested = true` and calls
 *     `abortAllInFlightTools()` so any execFile child processes die.
 *  3. The agent loop's existing cancel checks at brain.ts:634 / 791
 *     bail out.
 *  4. Clippy speaks a synthetic "stopping because you took over" line.
 *
 * Performance
 * ───────────
 * Polling cost is negligible: powerMonitor.getSystemIdleTime() is a
 * direct OS API call (CGEventSourceSecondsSinceLastEventType on macOS,
 * GetLastInputInfo on Windows). 500ms cadence × the few seconds of an
 * average task = ~20 polls per task. Not measurable in profiles.
 */

import { powerMonitor, screen } from 'electron';
import { createLogger } from './logger';

const log = createLogger('Takeover');

/**
 * Window after a Clippy-initiated input event during which we IGNORE
 * any system idle-reset signal as "probably Clippy's own click landing."
 * 1500ms balances:
 *  - long enough that the OS-level event registration + idle-counter
 *    update doesn't race past our window (typical < 200ms)
 *  - short enough that a genuine user click within ~2s of Clippy's last
 *    action still triggers the takeover
 */
const GRACE_WINDOW_MS = 1500;

/** Poll cadence. 500ms = ~2 Hz, plenty for user-interaction latency. */
const POLL_INTERVAL_MS = 500;

/**
 * Idle-time threshold below which we consider input to have "just
 * happened." getSystemIdleTime returns seconds (integer on most
 * platforms). A value of 1 means "the user did something in the last
 * second." 0 also possible.
 */
const FRESH_INPUT_THRESHOLD_SEC = 1;

export type TakeoverReason = 'user_takeover' | 'user_typed' | 'user_moved_cursor';

export interface TakeoverCallback {
  (reason: TakeoverReason, detail: { idleSec: number; cursorDelta?: number }): void;
}

let monitorActive = false;
let pollTimer: NodeJS.Timeout | null = null;
let lastClippyInputAt = 0;
let detectionPaused = false;
let callback: TakeoverCallback | null = null;
let lastSeenIdleSec = 999;
let lastCursorPoint: { x: number; y: number } | null = null;
let cursorJumpThreshold = 100;  // px movement to count as "user grabbed the mouse"

/**
 * Called by the tool dispatcher BEFORE and AFTER every input-generating
 * tool fires. Records the timestamp so the next ~1.5s of idle-resets
 * are attributed to Clippy, not to the user.
 */
export function noteClippyInput(toolName: string): void {
  lastClippyInputAt = Date.now();
  if (monitorActive) {
    log.debug('Clippy input noted', { tool: toolName, ts: lastClippyInputAt });
  }
}

/**
 * Briefly disable detection. Used by the STT pipeline during voice
 * recording so the user's expected keyboard/mouse activity (e.g.
 * pressing Esc to cancel) doesn't false-positive as takeover.
 */
export function pauseDetection(): void {
  detectionPaused = true;
  log.info('Detection paused');
}

export function resumeDetection(): void {
  detectionPaused = false;
  log.info('Detection resumed');
}

/**
 * Start watching for user input. Caller (brain.ts) calls this when a
 * task starts and `stop()` when the task ends (success, error, or sleep).
 *
 * Idempotent: safe to call multiple times.
 */
export function start(cb: TakeoverCallback): void {
  if (monitorActive) {
    callback = cb;  // refresh the callback in case the brain restarted
    return;
  }
  monitorActive = true;
  callback = cb;
  detectionPaused = false;
  lastSeenIdleSec = powerMonitor.getSystemIdleTime();
  lastCursorPoint = screen.getCursorScreenPoint();
  log.info('Takeover monitor started', { initial_idle: lastSeenIdleSec });

  pollTimer = setInterval(() => {
    if (detectionPaused) return;
    const now = Date.now();
    const idleSec = powerMonitor.getSystemIdleTime();
    const cursor = screen.getCursorScreenPoint();

    // Detect idle-time DROP. If idleSec is small and we previously
    // observed it being larger, *something* just produced an input.
    // We don't trust a single small value alone — we trust the TRANSITION
    // because some platforms quantize getSystemIdleTime weirdly at boundaries.
    const idleDropped = idleSec <= FRESH_INPUT_THRESHOLD_SEC && lastSeenIdleSec > FRESH_INPUT_THRESHOLD_SEC;

    // Detect cursor jump independent of the idle counter. macOS in
    // particular sometimes lags the idle-counter update when the user
    // grabs the mouse, but a cursor position change is immediate.
    let cursorDelta = 0;
    if (lastCursorPoint) {
      cursorDelta = Math.abs(cursor.x - lastCursorPoint.x) + Math.abs(cursor.y - lastCursorPoint.y);
    }
    const cursorJumped = cursorDelta > cursorJumpThreshold;

    // Was this likely Clippy-origin?
    const sinceClippyInput = now - lastClippyInputAt;
    const inGrace = sinceClippyInput < GRACE_WINDOW_MS;

    if ((idleDropped || cursorJumped) && !inGrace && callback) {
      const reason: TakeoverReason = cursorJumped && !idleDropped
        ? 'user_moved_cursor'
        : idleDropped && !cursorJumped
        ? 'user_typed'
        : 'user_takeover';
      log.warn('User takeover detected', {
        reason,
        idleSec,
        prevIdleSec: lastSeenIdleSec,
        cursorDelta,
        since_clippy_input_ms: sinceClippyInput,
      });
      try { callback(reason, { idleSec, cursorDelta }); } catch (err) {
        log.error('Takeover callback threw', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    lastSeenIdleSec = idleSec;
    lastCursorPoint = cursor;
  }, POLL_INTERVAL_MS);
}

export function stop(): void {
  if (!monitorActive) return;
  monitorActive = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  callback = null;
  detectionPaused = false;
  log.info('Takeover monitor stopped');
}

export function isActive(): boolean {
  return monitorActive;
}
