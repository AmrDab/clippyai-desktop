import { BrowserWindow } from 'electron';
import type { Brain } from './brain';
import { createLogger } from './logger';

const log = createLogger('Scheduler');

/**
 * v0.16.1 — Time-based liveliness scheduler.
 *
 * Why setInterval and not node-cron?
 *   We have three fixed daily events, no per-skill cron strings yet, and
 *   adding a runtime dep + native binding for ~3 hard-coded checks is
 *   over-engineering. If we later add user-defined scheduled skills with
 *   arbitrary cron expressions, we can swap the body of tick() for a
 *   node-cron registry. The public surface (start/stop) stays the same.
 *
 * Events:
 *   - 09:00 daily, app awake → morning greeting (Wave, "Good morning!")
 *   - Every 2 hr during 9-17 weekdays, app awake → stretch reminder
 *   - 17:30 weekdays, app awake → wrap-up tip
 *
 * Once-per-day gating: each event tracks its last-fired YYYY-MM-DD locally.
 * If the app is closed when an event would have fired, it does NOT fire on
 * the next launch (we don't want "Good morning at 6pm because you opened me
 * late"). Stretch reminder is interval-based not date-based — it fires the
 * NEXT time the 55min cadence aligns within the work-hours window.
 */

type EventName = 'morning_greeting' | 'wrap_up_tip' | 'stretch_break';

interface SchedulerState {
  lastFiredDate: Partial<Record<EventName, string>>;
  lastStretchAt: number;
}

const state: SchedulerState = {
  lastFiredDate: {},
  lastStretchAt: 0,
};

// v0.16.2 — was 55 min, bumped to 2hr per user feedback that v0.16.1 was
// over-animating. A stretch chime every 55 min while the user is heads-down
// on a task is more annoying than helpful. 2hr lines up with the "Pomodoro
// long break" cadence — three 25-min focus blocks plus shorter breaks.
const STRETCH_INTERVAL_MS = 120 * 60 * 1000;
const TICK_MS = 60 * 1000; // 1 minute resolution is plenty for daily events

let timer: NodeJS.Timeout | null = null;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fire(
  win: BrowserWindow,
  event: EventName,
  text: string,
  animate: string,
): void {
  if (win.isDestroyed()) return;
  log.info('Scheduler.fire', { event, text });
  win.webContents.send('clippy-speak', { text, animate });
  // brain's onSpeak listener doesn't exist; clippy-speak goes straight to
  // the renderer bubble + TTS. That's the same channel proactive tips use.
}

function tick(win: BrowserWindow, brain: Brain): void {
  if (win.isDestroyed()) return;
  if (brain.getMode() !== 'awake') return; // never wake-up to greet a sleeping Clippy

  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dow = now.getDay(); // 0 Sun ... 6 Sat
  const today = ymd(now);

  // ── Morning greeting: 09:00–09:14 window (so we catch it on the first
  //    tick after 9am regardless of when in the minute we landed). Gated
  //    once-per-day.
  if (hour === 9 && minute < 15 && state.lastFiredDate.morning_greeting !== today) {
    state.lastFiredDate.morning_greeting = today;
    const greetings = [
      "Good morning! Ready to tackle today? 📎",
      "Morning! What's first on the list? ☕",
      "Hey, good morning! I'm here whenever you need me. 📎",
    ];
    fire(win, 'morning_greeting', greetings[Math.floor(Math.random() * greetings.length)], 'Wave');
    return; // don't double-fire stretch in the same tick
  }

  // ── Wrap-up tip: 17:30–17:44 window, weekdays only, once per day.
  if (
    dow >= 1 && dow <= 5 &&
    hour === 17 && minute >= 30 && minute < 45 &&
    state.lastFiredDate.wrap_up_tip !== today
  ) {
    state.lastFiredDate.wrap_up_tip = today;
    const tips = [
      "End of day! Any quick wins before you wrap up? 📎",
      "It's about that time — anything I can help close out? 📎",
      "Heading out? Want me to summarize what you worked on today? 📎",
    ];
    fire(win, 'wrap_up_tip', tips[Math.floor(Math.random() * tips.length)], 'GetAttention');
    return;
  }

  // ── Stretch break: every 2 hr, weekdays 9-17, app awake. Interval-based
  //    so it adapts to when the user actually opened the app.
  if (dow >= 1 && dow <= 5 && hour >= 9 && hour < 17) {
    if (state.lastStretchAt === 0) {
      // First eligible tick — initialize so the first stretch doesn't fire
      // immediately on launch.
      state.lastStretchAt = Date.now();
    } else if (Date.now() - state.lastStretchAt >= STRETCH_INTERVAL_MS) {
      state.lastStretchAt = Date.now();
      const stretches = [
        "Time to stretch! Stand up for a minute? 📎",
        "Quick break? Your eyes will thank you. 📎",
        "Stretch time — shoulders and neck especially. 📎",
      ];
      fire(win, 'stretch_break', stretches[Math.floor(Math.random() * stretches.length)], 'GestureUp');
    }
  }
}

export function startScheduler(win: BrowserWindow, brain: Brain): void {
  stopScheduler();
  // First tick after 30s so we don't slam the user with a greeting on app
  // launch even if it's exactly 9:00. Subsequent ticks at TICK_MS cadence.
  setTimeout(() => {
    tick(win, brain);
    timer = setInterval(() => tick(win, brain), TICK_MS);
  }, 30_000);
  log.info('Scheduler.started');
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
