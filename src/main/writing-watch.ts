// writing-watch.ts — the "always-on" half of the writing assistant.
//
// The ⌥G flow (writing-assist.ts) is on-demand: press the hotkey, Clippy
// reads the focused field, lints it with the on-device Harper engine, and
// offers a fix card. This watcher makes it AMBIENT — like Grammarly: while
// Clippy is awake, it quietly checks the field you're typing in and, when it
// spots fixable issues, shows a small badge near the field. Click the badge
// (or press ⌥G) to open the same fix card.
//
// No keystroke tap needed (this branch has no input monitor): it POLLS the
// system-wide focused element on a slow cadence and only acts on a *pause* —
// the field value has to hold still for one tick (you stopped typing) before
// it lints, so it never fires mid-word and never lints the same text twice.
//
// Privacy: identical posture to ⌥G — the field text is linted ON-DEVICE
// (Harper, no network). Nothing about your typing leaves the machine here;
// the cloud is only touched if you later open the card and ask for an AI
// rewrite. Bound to awake/eyes-open like every other sense.
//
// The pure decision bits (isEditableRole, WatchCore) carry no Electron/bridge
// deps so the smoke layer-1 harness exercises the real logic.

import type { BrowserWindow } from 'electron';
import { lintText } from './harper-lint';
import * as macBridge from './mac-bridge-native';
import { BridgeError } from './mac-bridge-native';
import { createWritingBadgeWindow, hideWritingBadge } from './window';
import { createLogger } from './logger';

const log = createLogger('WritingWatch');

/** AX roles that represent an editable text surface worth watching. */
export function isEditableRole(role: string | undefined | null): boolean {
  if (!role) return false;
  const r = role.toLowerCase();
  return (
    r.includes('textfield') ||
    r.includes('textarea') ||
    r === 'axcombobox' ||
    r.includes('searchfield')
  );
}

/** A focused-element snapshot the core reasons about (subset of the bridge result). */
export interface FocusSample {
  role: string | null;
  value: string | null;
}

export type WatchAction =
  | { kind: 'idle' }                 // nothing to do (no change / still typing)
  | { kind: 'hide' }                 // not an editable field, or it emptied → drop any badge
  | { kind: 'lint'; value: string }; // a stable pause on new text → lint it now

/**
 * Pure decision core. Fed a focus sample each tick; decides whether to lint,
 * hide, or do nothing — WITHOUT any I/O. State it keeps:
 *  - lastValue: the value seen on the previous tick (to detect a "pause" =
 *    two consecutive identical non-empty values).
 *  - lastLinted: the most recent value we actually linted (so a steady,
 *    already-checked field doesn't re-lint every tick).
 * markBadged()/clear() let the watcher record what it surfaced.
 */
export class WatchCore {
  private lastValue: string | null = null;
  private lastLinted: string | null = null;

  next(sample: FocusSample): WatchAction {
    const editable = isEditableRole(sample.role);
    const value = sample.value ?? '';

    if (!editable || value.trim().length === 0) {
      this.lastValue = null;
      return { kind: 'hide' };
    }

    const prev = this.lastValue;
    this.lastValue = value;

    // Only act once typing has settled: the same text must survive two ticks.
    if (value !== prev) return { kind: 'idle' };
    // Don't re-lint text we already linted (the badge, if any, still stands).
    if (value === this.lastLinted) return { kind: 'idle' };

    this.lastLinted = value;
    return { kind: 'lint', value };
  }

  /** Forget history — call on sleep / disable so the next session starts fresh. */
  reset(): void {
    this.lastValue = null;
    this.lastLinted = null;
  }
}

const POLL_MS = 2200;

// Apps (lowercased) where a11yFocused() consistently times out OR where we
// have no useful text to lint. We use a fast CGWindowList pre-check
// (activeWindow, no AX needed, <100ms) to skip these entirely.
const CHROMIUM_SKIP_APPS = new Set([
  'claude',          // Claude.app (Electron, Chromium webview)
  'google chrome',
  'chromium',
  'microsoft edge',
  'brave browser',
  'arc',
  'opera',
  'vivaldi',
  // macOS system processes — "loginwindow" is returned when the bridge
  // subprocess doesn't have a proper GUI session (e.g. nohup/daemon launch).
  'loginwindow',
  'dock',
  'systemuiserver',
  'controlstrip',
]);

export class WritingWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly core = new WatchCore();
  private running = false;
  private ticking = false;
  private badgedValue: string | null = null;
  private permWarnedAt = 0;     // rate-limit the permission warn to once/60s
  private errorStreak = 0;      // consecutive transient errors — used for backoff
  private skipUntilTick = 0;    // skip ticks while in backoff
  private tickCount = 0;

  constructor(
    private readonly win: BrowserWindow,
    /** Live gate — return false to suppress (Settings toggle / not macOS). */
    private readonly enabled: () => boolean,
  ) {}

  start(): void {
    if (this.running || process.platform !== 'darwin') return;
    this.running = true;
    this.core.reset();
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    log.info('Writing watcher started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.core.reset();
    this.badgedValue = null;
    try { hideWritingBadge(); } catch { /* window may be gone */ }
  }

  private async tick(): Promise<void> {
    this.tickCount++;
    if (this.ticking || !this.enabled()) return;
    // Backoff: after repeated transient failures, skip ticks to avoid hammering.
    if (this.tickCount < this.skipUntilTick) return;

    this.ticking = true;
    try {
      // Fast pre-check: skip Chromium-based apps (and unknown apps) where
      // a11yFocused times out. activeWindow() uses CGWindowList (no AX TCC),
      // completes in <100ms. If it fails or the app is unknown, we skip rather
      // than burning 5s on a doomed a11yFocused call.
      const aw = await macBridge.activeWindow().catch(() => null);
      log.debug('WritingWatch.active-app', { app: aw?.app ?? null });
      if (!aw) {
        log.debug('WritingWatch.skip no-active-window');
        this.errorStreak = 0;
        return;
      }
      const appName = (aw.app ?? '').toLowerCase();
      if (!appName || CHROMIUM_SKIP_APPS.has(appName)) {
        log.debug('WritingWatch.skip', { app: aw.app, reason: appName ? 'chromium' : 'unknown-app' });
        if (this.badgedValue !== null) { this.badgedValue = null; hideWritingBadge(); }
        this.errorStreak = 0;
        return;
      }

      const f = await macBridge.a11yFocused();
      this.errorStreak = 0; // successful bridge call — reset backoff
      const editable = isEditableRole(f.role);
      log.debug('WritingWatch.tick', {
        role: f.role,
        editable,
        app: f.app,
        valueLen: f.value?.length ?? 0,
      });

      const action = this.core.next({ role: f.role, value: f.value });

      if (action.kind === 'hide') {
        if (this.badgedValue !== null) { this.badgedValue = null; hideWritingBadge(); }
        return;
      }
      if (action.kind !== 'lint') return;

      const lints = await lintText(action.value);
      log.info('WritingWatch.linted', { app: f.app, chars: action.value.length, fixes: lints.length });
      if (lints.length === 0) {
        if (this.badgedValue !== null) { this.badgedValue = null; hideWritingBadge(); }
        return;
      }
      // Found fixes — surface a badge near the field (idempotent per value).
      if (this.badgedValue === action.value) return;
      this.badgedValue = action.value;
      log.info('Writing fixes spotted', { app: f.app, count: lints.length });
      createWritingBadgeWindow(f.bounds, lints.length);
    } catch (err) {
      if (err instanceof BridgeError && err.kind === 'permission') {
        const now = Date.now();
        if (now - this.permWarnedAt > 60_000) {
          this.permWarnedAt = now;
          log.warn('WritingWatch: Accessibility permission not granted — badge suppressed. Grant in System Settings → Privacy & Security → Accessibility.');
        }
        return;
      }
      // Transient (no focus, bridge timeout) — back off exponentially.
      this.errorStreak++;
      const backoffTicks = Math.min(Math.pow(2, this.errorStreak - 1), 8); // 1,2,4,8,8,8…
      this.skipUntilTick = this.tickCount + backoffTicks;
      log.debug('WritingWatch.tick transient error', {
        err: String(err).slice(0, 100),
        streak: this.errorStreak,
        backoffTicks,
      });
    } finally {
      this.ticking = false;
    }
  }
}
