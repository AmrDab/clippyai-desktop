/**
 * read-leak.ts — does an outgoing address carry text that was read earlier?
 *
 * The exfiltration chain is read, then send. Asking before every URL with a
 * query string after any read punished ordinary work ("read notes.txt and
 * google the first item"). So the question is narrower: does this address
 * actually contain content from what the task read, that the user did not
 * type themselves? Pure, so every case is unit-tested.
 *
 * What counts as carried content:
 *   - a value with no spaces from the read text, 16+ characters long, or 10+
 *     and secret-looking (letters with digits, mixed case, or _ = +): a key,
 *     a token, a password, an id;
 *   - a passage of 48+ characters (spaces included): the address is carrying
 *     a chunk of the document, not a search phrase;
 *   - either of those inside a base64 / hex blob in the address.
 * What does not: short ordinary words and phrases (a search for an item in a
 * list), anything that is also in the user's own message, and a link that
 * appears as is in what was read ("open the link in this file").
 */

const VALUE_RE = /[A-Za-z0-9_+.@~%-]{10,}/g;
const LONG_VALUE = 16;
const PASSAGE = 48;

function secretLooking(v: string): boolean {
  return (/[0-9]/.test(v) && /[A-Za-z]/.test(v)) || /[a-z][A-Z]/.test(v) || /[_=+]/.test(v);
}

const squash = (s: string): string => s.replace(/\s+/g, ' ');

function decodeAll(s: string): string[] {
  const out = [s];
  try { out.push(decodeURIComponent(s)); } catch { /* malformed escapes: keep raw */ }
  try { out.push(decodeURIComponent(s.replace(/\+/g, ' '))); } catch { /* keep raw */ }
  return [...new Set(out)];
}

/** Printable text hidden in base64 / base64url / hex blobs of `s`. */
function decodedBlobs(s: string): string[] {
  const out: string[] = [];
  const printable = (t: string) => t.length >= 10 && (t.match(/[\x20-\x7e]/g)?.length ?? 0) / t.length > 0.9;
  for (const m of s.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []) {
    try {
      const t = Buffer.from(m.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (printable(t)) out.push(t);
    } catch { /* not base64 */ }
  }
  for (const m of s.match(/(?:[0-9a-fA-F]{2}){12,}/g) ?? []) {
    const t = Buffer.from(m, 'hex').toString('utf8');
    if (printable(t)) out.push(t);
  }
  return out;
}

/** Content of `read` found in `outbound` and not in the user's message; null when none. */
function carriedPlain(outbound: string, read: string, userLower: string): string | null {
  for (const m of read.match(VALUE_RE) ?? []) {
    const v = m.replace(/^[.%~-]+|[.%~-]+$/g, '');
    if (v.length < 10 || (v.length < LONG_VALUE && !secretLooking(v))) continue;
    if (outbound.includes(v) && !userLower.includes(v.toLowerCase())) return `a ${v.length}-character value`;
  }
  const out = squash(outbound);
  if (out.length < PASSAGE) return null;
  const grams = new Set<string>();
  for (let i = 0; i + PASSAGE <= out.length; i++) grams.add(out.substring(i, i + PASSAGE));
  const text = squash(read);
  for (let i = 0; i + PASSAGE <= text.length; i++) {
    const g = text.substring(i, i + PASSAGE);
    if (grams.has(g) && !userLower.includes(g.toLowerCase())) return 'a passage of the text';
  }
  return null;
}

export interface LeakInput {
  /** The address (and request body, if any) about to be opened or sent. */
  outbound: string;
  /** Results of the task's recent reads (file text, clipboard, command output). */
  reads: string[];
  /** The user's own message for this task. */
  userMessage: string;
  /** Host of the address, when it is a URL: it is the destination, not the payload. */
  host?: string;
}

/**
 * What the address carries from the reads ("a 24-character value", "a passage
 * of the text"), or null when it carries nothing the user did not type.
 */
export function carriedReadContent(input: LeakInput): string | null {
  const raw = String(input.outbound ?? '').trim();
  if (!raw) return null;
  // A link that is written out in a read result adds nothing to it: opening
  // it is "open the link in this file". Only the OTHER reads can leak into it.
  const reads = input.reads.filter((r) => r && !r.includes(raw));
  if (reads.length === 0) return null;
  const userLower = String(input.userMessage ?? '').toLowerCase();
  const host = String(input.host ?? '');
  const forms = decodeAll(raw).map((f) => (host ? f.split(host).join(' ') : f));
  const candidates = [...forms, ...forms.flatMap(decodedBlobs)];
  for (const read of reads) {
    for (const c of candidates) {
      const hit = carriedPlain(c, read, userLower);
      if (hit) return hit;
    }
  }
  return null;
}
