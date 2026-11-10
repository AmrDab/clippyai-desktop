/**
 * onboarding-track.ts — where is setup abandoned? A tiny tracker for the
 * email + code screen: which step the user reached, how long they stayed on it,
 * and whether they finished. Pure (the clock is injected); main wires it to
 * telemetry. Steps are fixed enums, nothing the user typed.
 */
export const ONBOARDING_STEPS = ['email_focused', 'code_screen_shown', 'resend_clicked', 'verified'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(v: unknown): v is OnboardingStep {
  return typeof v === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(v);
}

export interface ClosedInfo {
  lastStep: string;
  completed: boolean;
  /** Time spent on the last step, ms. */
  timeInStepMs: number;
}

export class OnboardingTracker {
  private last = 'opened';
  private lastAt: number;
  private completed = false;
  /** Steps already reported, so a repeated focus is one event (resend can repeat). */
  private seen = new Set<string>();

  constructor(now: number) {
    this.lastAt = now;
  }

  /** Record a step. Returns true when it should be sent as an event (first time, or a resend). */
  note(step: OnboardingStep, now: number): boolean {
    const fresh = !this.seen.has(step) || step === 'resend_clicked';
    this.seen.add(step);
    this.last = step;
    this.lastAt = now;
    if (step === 'verified') this.completed = true;
    return fresh;
  }

  closed(now: number): ClosedInfo {
    return { lastStep: this.last, completed: this.completed, timeInStepMs: Math.max(0, now - this.lastAt) };
  }
}
