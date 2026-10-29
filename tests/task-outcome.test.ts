import { describe, it, expect } from 'vitest';
import { taskOutcomeFor } from '../src/main/task-outcome';

describe('taskOutcomeFor', () => {
  it('maps abort reasons to the bubble outcome', () => {
    expect(taskOutcomeFor(null, false)).toBe('done');
    expect(taskOutcomeFor('user_stop', false)).toBe('stopped');
    expect(taskOutcomeFor('runaway_guard', false)).toBe('stuck');
    expect(taskOutcomeFor('loop_detector', false)).toBe('stuck');
    expect(taskOutcomeFor('max_steps', false)).toBe('step_limit');
    expect(taskOutcomeFor('task_failed_sentinel', false)).toBe('failed');
    expect(taskOutcomeFor('sleep', false)).toBe('done');
    expect(taskOutcomeFor('user_override', false)).toBe('done');
  });
  it('an unconfirmed success claim wins over everything', () => {
    expect(taskOutcomeFor(null, true)).toBe('unconfirmed');
  });
});
