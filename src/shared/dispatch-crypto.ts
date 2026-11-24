// Clippy Dispatch: the end-to-end crypto and the message types the PC and the phone page share
// (docs/dispatch-protocol.md). WebCrypto only (no Node or Electron imports), so the phone page bundles this file too.

/** What the phone sends to the PC. */
export type PhoneMsg =
  | { type: 'req'; id: string; text: string }        // a task
  | { type: 'power'; on: boolean }                   // the On/Off switch
  | { type: 'reply'; id: string; yes: boolean }      // the answer to an ask
  | { type: 'stop' };                                // stop the running task

export type DispatchState = 'asleep' | 'ready' | 'working';

/** What the PC sends to the phone. */
export type PcMsg =
  | { type: 'status'; state: DispatchState; text?: string }
  | { type: 'answer'; text: string; id?: string }
  | { type: 'ask'; id: string; question: string; reason?: string; choices: string[] }
  | { type: 'ask-done'; id: string };

/** What the relay itself says (text frames; ciphertext is binary frames). The last three come just before it closes. */
export type RelayMsg = { t: 'peer'; on: boolean } | { t: 'unpaired' | 'expired' | 'replaced' };

/** The relay's close codes. Only unpaired / badAuth / gone / taken end a pairing; `replaced` is a newer socket of the same side. */
export const CLOSE = { unpaired: 4000, replaced: 4001, rate: 4008, badAuth: 4403, gone: 4404, taken: 4409 } as const;
export const endsPairing = (code: number): boolean =>
  code === CLOSE.unpaired || code === CLOSE.badAuth || code === CLOSE.gone || code === CLOSE.taken;

export type Side = 'pc' | 'phone';

const enc = new TextEncoder();
const dec = new TextDecoder();
// Uint8Array (not ArrayBuffer) into WebCrypto: Node's webcrypto wants its own realm's types under some test runners.
const u8 = (b: ArrayBuffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomB64url(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads `#r=<room>&k=<secret>` from the QR link. */
export function parseFragment(hash: string): { room: string; secret: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const room = p.get('r') ?? '', secret = p.get('k') ?? '';
  return /^[\w-]{22}$/.test(room) && /^[\w-]{43}$/.test(secret) ? { room, secret } : null;
}

export interface Channel {
  seal(msg: object): Promise<ArrayBuffer>;
  /** Throws on a wrong key, a changed frame, a frame of another connection, or one that was already seen (a replay). */
  open(frame: ArrayBuffer): Promise<any>;
}

// Every binary frame starts with one byte that says what it is.
const HELLO = 0, DATA = 1;
const NONCE_BYTES = 16;

/** Is this frame a hello (each side sends one when the other is there)? Anything else is ciphertext. */
export const isHello = (frame: ArrayBuffer): boolean => frame.byteLength > 0 && new Uint8Array(frame)[0] === HELLO;

export interface DispatchKeys {
  /** The room's access token for the relay (43 chars). It is derived from the secret but cannot decrypt anything. */
  auth: string;
  /** This side's hello for a new connection: a fresh nonce, signed. Send it to the other side as it is. */
  hello(): Promise<ArrayBuffer>;
  /**
   * The other side's hello: the connection's channel, with keys made from both nonces. Throws when the hello was not
   * signed by the other side (a forged one, or this side's own sent back), and when this side's nonce was used
   * already: one hello() makes one channel.
   */
  channel(peerHello: ArrayBuffer): Promise<Channel>;
}

/**
 * Keys from the pairing secret with HKDF-SHA-256. The relay token (`auth`) is fixed for the pairing. A hello is a
 * random nonce with an HMAC over room + role + nonce, so only the two holders of the secret can make one and neither
 * takes its own back. The AES-256-GCM keys (one per direction) are new for every connection:
 * HKDF(secret, salt = pcNonce|phoneNonce), so a frame recorded in an earlier connection opens in no later one. A data
 * frame is a 12-byte random IV followed by the ciphertext of `{ ...msg, n }`; `n` only goes up, for the life of the key.
 */
export async function dispatchKeys(secret: string, room: string, side: Side): Promise<DispatchKeys> {
  const base = await crypto.subtle.importKey('raw', unb64url(secret), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hkdf = (info: string, salt: Uint8Array<ArrayBuffer> = enc.encode(room)) => ({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) });
  const auth = b64url(new Uint8Array(await crypto.subtle.deriveBits(hkdf('clippy-dispatch auth'), base, 256)));
  const mac = await crypto.subtle.deriveKey(hkdf('clippy-dispatch hello'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  const signed = (from: Side, nonce: Uint8Array) => enc.encode(`${room} ${from} ${b64url(nonce)}`);
  const peer: Side = side === 'pc' ? 'phone' : 'pc';
  let mine: Uint8Array | null = null;
  return {
    auth,
    async hello() {
      const nonce = mine = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const tag = new Uint8Array(await crypto.subtle.sign('HMAC', mac, signed(side, nonce)));
      const frame = new Uint8Array(1 + NONCE_BYTES + tag.length);
      frame[0] = HELLO;
      frame.set(nonce, 1);
      frame.set(tag, 1 + NONCE_BYTES);
      return frame.buffer;
    },
    async channel(peerHello) {
      const nonce = mine;
      mine = null;                                    // one nonce, one channel: a hello sent again makes nothing
      if (!nonce) throw new Error('no hello of our own');
      if (!isHello(peerHello) || peerHello.byteLength !== 1 + NONCE_BYTES + 32) throw new Error('not a hello');
      const theirs = new Uint8Array(peerHello.slice(1, 1 + NONCE_BYTES));
      if (!(await crypto.subtle.verify('HMAC', mac, u8(peerHello.slice(1 + NONCE_BYTES)), signed(peer, theirs)))) throw new Error('hello not from the other side');
      const salt = new Uint8Array(2 * NONCE_BYTES);   // the PC's nonce first
      salt.set(side === 'pc' ? nonce : theirs, 0);
      salt.set(side === 'pc' ? theirs : nonce, NONCE_BYTES);
      const key = (from: Side) => crypto.subtle.deriveKey(hkdf(from === 'pc' ? 'pc->phone' : 'phone->pc', salt), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const [out, inn] = await Promise.all([key(side), key(peer)]);
      let sent = 0, seen = 0;
      // One at a time, in call order: frames leave and are read in the order of their `n`.
      let line: Promise<unknown> = Promise.resolve();
      const inOrder = <T>(job: () => Promise<T>): Promise<T> => {
        const done = line.then(job);
        line = done.catch(() => {});
        return done;
      };
      return {
        seal: (msg) => inOrder(async () => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, out, enc.encode(JSON.stringify({ ...msg, n: ++sent })));
          const frame = new Uint8Array(13 + data.byteLength);
          frame[0] = DATA;
          frame.set(iv, 1);
          frame.set(new Uint8Array(data), 13);
          return frame.buffer;
        }),
        open: (frame) => inOrder(async () => {
          if (new Uint8Array(frame)[0] !== DATA) throw new Error('not a data frame');
          const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8(frame.slice(1, 13)) }, inn, u8(frame.slice(13)));
          const { n, ...msg } = JSON.parse(dec.decode(data));
          if (typeof n !== 'number' || n <= seen) throw new Error('replayed frame');
          seen = n;
          return msg;
        }),
      };
    },
  };
}
