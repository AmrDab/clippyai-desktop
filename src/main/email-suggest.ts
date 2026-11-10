/**
 * email-suggest.ts — "Did you mean ana@gmail.com?" for mistyped mail domains.
 * Pure, no imports (renderer-safe). The idea (compare the domain with a list of
 * common ones by edit distance) follows the approach of mailcheck /
 * ZooTools email-spell-checker (MIT); this is our own small implementation.
 * It only ever suggests; sending is never blocked.
 */

const COMMON_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'mail.com', 'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'qq.com',
  'hotmail.co.uk', 'yahoo.co.uk', 'outlook.com.br', 'hotmail.com.br', 'yahoo.com.br', 'uol.com.br', 'bol.com.br',
  'hotmail.es', 'yahoo.es', 'hotmail.fr', 'yahoo.fr', 'orange.fr', 'free.fr', 'laposte.net', 'wanadoo.fr',
];

/** Optimal-string-alignment distance: insert, delete, substitute, swap neighbours. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** A corrected address, or null when the domain is fine, unknown, or nothing is close. */
export function suggestEmail(email: string): string | null {
  const trimmed = (email || '').trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (COMMON_DOMAINS.includes(domain)) return null;
  let best: string | null = null;
  let bestDist = 3;
  for (const c of COMMON_DOMAINS) {
    const dist = editDistance(domain, c);
    // One slip always counts; two only for long names, so short domains
    // (a company's own "abc.io") are not "corrected".
    const limit = c.length >= 9 ? 2 : 1;
    if (dist <= limit && dist < bestDist) { best = c; bestDist = dist; }
  }
  return best ? `${local}@${best}` : null;
}

/** Inbox shortcut for the code stage; the URL carries only our sender address, never the user's. */
export function inboxLink(email: string): { provider: 'gmail' | 'outlook'; url: string } | null {
  const domain = (email.split('@')[1] || '').trim().toLowerCase();
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { provider: 'gmail', url: 'https://mail.google.com/mail/u/0/#search/from%3Ahello%40clippyai.app+newer_than%3A1d' };
  }
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) {
    return { provider: 'outlook', url: 'https://outlook.live.com/mail/0/' };
  }
  return null;
}

/** The only two inbox URLs the app may open (exact match; they contain no user data). */
export function isSafeInboxUrl(url: string): boolean {
  return inboxLink('a@gmail.com')!.url === url || inboxLink('a@outlook.com')!.url === url;
}
