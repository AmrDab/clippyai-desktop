/** v0.22 — how a task ended, for the bubble's header status. */
export type TaskOutcome = 'done' | 'stopped' | 'stuck' | 'step_limit' | 'failed' | 'unconfirmed';
export function taskOutcomeFor(abortReason: string | null, unconfirmed: boolean): TaskOutcome {
  if (unconfirmed) return 'unconfirmed';
  switch (abortReason) {
    case 'user_stop': return 'stopped';
    case 'runaway_guard':
    case 'loop_detector': return 'stuck';
    case 'max_steps': return 'step_limit';
    case 'task_failed_sentinel': return 'failed';
    default: return 'done'; // clean finish, sleep, or overridden by a new message
  }
}
