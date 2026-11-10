import { describe, it, expect } from 'vitest';
import { OnboardingTracker, isOnboardingStep } from '../src/main/onboarding-track';

describe('OnboardingTracker', () => {
  it('reports each step once, but every resend', () => {
    const t = new OnboardingTracker(0);
    expect(t.note('email_focused', 10)).toBe(true);
    expect(t.note('email_focused', 20)).toBe(false);
    expect(t.note('code_screen_shown', 30)).toBe(true);
    expect(t.note('resend_clicked', 40)).toBe(true);
    expect(t.note('resend_clicked', 50)).toBe(true);
  });
  it('closed() gives the last step, time on it and whether setup finished', () => {
    const t = new OnboardingTracker(0);
    t.note('email_focused', 1000);
    t.note('code_screen_shown', 4000);
    expect(t.closed(9000)).toEqual({ lastStep: 'code_screen_shown', completed: false, timeInStepMs: 5000 });
    t.note('verified', 9500);
    expect(t.closed(9600).completed).toBe(true);
  });
  it('a window closed before anything happened has last_step "opened"', () => {
    expect(new OnboardingTracker(100).closed(600)).toEqual({ lastStep: 'opened', completed: false, timeInStepMs: 500 });
  });
  it('only fixed step names are accepted from the renderer', () => {
    expect(isOnboardingStep('email_focused')).toBe(true);
    expect(isOnboardingStep('my.secret@mail.com')).toBe(false);
    expect(isOnboardingStep(undefined)).toBe(false);
  });
});
