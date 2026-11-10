/**
 * account-input.ts — input rules for the email + code screen. No imports, so
 * both the main process and the onboarding renderer bundle can use it.
 */

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Digits only, at most 6 — what the code input shows after typing or pasting. */
export function normalizeCode(raw: string): string {
  return (raw || '').replace(/\D/g, '').slice(0, 6);
}

export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}
