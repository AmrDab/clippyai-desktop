/**
 * account-copy.ts — turns an account error (from the main process) into the
 * user's language, and says how long to hold the resend link. Pure and
 * renderer-safe; the one place that knows the error copy.
 */
import { t, type Lang } from './i18n';

export interface AccountError {
  error: string;
  triesLeft?: number;
  retryAfter?: number;
}

/** Up to 90 minutes is "wait N min"; longer (the 10-per-day cap) is "try again tomorrow". */
const SHORT_WAIT_MAX_S = 5400;

export function accountErrorText(lang: Lang, e: AccountError): string {
  switch (e.error) {
    case 'invalid_email': return t(lang, 'err.invalid_email');
    case 'rate_limited':
      if (typeof e.retryAfter === 'number' && e.retryAfter > SHORT_WAIT_MAX_S) return t(lang, 'err.rate_limited_day');
      return t(lang, 'err.rate_limited', { n: Math.max(1, Math.ceil((e.retryAfter ?? 60) / 60)) });
    case 'wrong_code':
      return e.triesLeft && e.triesLeft > 0
        ? t(lang, 'err.wrong_code', { n: e.triesLeft })
        : t(lang, 'err.wrong_code_last');
    case 'code_expired': return t(lang, 'err.code_expired');
    case 'offline': return t(lang, 'err.offline');
    default: return t(lang, 'err.server');
  }
}

/** Errors after which the typed digits are useless (wrong or dead code) and a new code is the only way on. */
export function clearsCodeInput(e: AccountError): boolean {
  return e.error === 'wrong_code' || e.error === 'code_expired';
}

/** A new code is needed right now: the last try failed or the code is gone. */
export function needsNewCode(e: AccountError): boolean {
  return e.error === 'code_expired' || (e.error === 'wrong_code' && !(e.triesLeft && e.triesLeft > 0));
}

/** Seconds to hold "Send a new code" after a send / a 429 (server value wins, 30 s default). */
export function resendHoldSeconds(e?: AccountError): number {
  if (e?.error === 'rate_limited' && typeof e.retryAfter === 'number') return e.retryAfter;
  return 30;
}

/** The countdown is shown up to two minutes; a longer hold just disables the link. */
export const RESEND_COUNTDOWN_MAX_S = 120;
