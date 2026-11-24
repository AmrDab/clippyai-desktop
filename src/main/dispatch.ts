/**
 * dispatch.ts — Clippy Dispatch, the PC side (docs/dispatch-protocol.md).
 *
 * A phone sends tasks to Clippy. This file makes the room and its QR link,
 * connects out to the relay, and passes end-to-end encrypted messages to and
 * from the phone page. ONE phone per PC: pairing a new phone replaces the old
 * room. The pairing is saved in userData/dispatch.json (secret + PC token
 * encrypted with safeStorage) and stays until the user removes it.
 *
 * Three parts, each testable alone: the saved pairing (loadRoom / saveRoom),
 * the socket (Link) and what a phone message does (createCore). Everything
 * that touches the brain or a window comes in through initDispatch().
 */

import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import QRCode from 'qrcode';
import { createLogger } from './logger';
import {
  dispatchKeys, endsPairing, isHello, parseFragment, randomB64url, sha256Hex,
  type Channel, type DispatchKeys, type DispatchState, type PcMsg, type RelayMsg,
} from '../shared/dispatch-crypto';

const log = createLogger('Dispatch');

const apiBase = (): string => (process.env.CLIPPY_DISPATCH_API || 'https://api.clippyai.app').replace(/\/+$/, '');
const siteBase = (): string => (process.env.CLIPPY_DISPATCH_SITE || 'https://clippyai.app').replace(/\/+$/, '');

// ── The saved pairing ────────────────────────────────────────────────

export interface RoomInfo {
  room: string;          // random id, 16 bytes as base64url
  secret: string;        // 32 bytes as base64url; only in the QR and on this PC
  pc: string;            // this PC's own token for the relay; never in the QR
  phonePaired: boolean;  // a phone has joined this room
  pairedAt: number;      // when the phone first joined (ms), 0 before
}

/** Electron's safeStorage, or a fake in tests. */
export interface Safe {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

/** The link in the QR. The room and the secret are in the fragment, which browsers never send to a server. */
export const qrUrl = (r: Pick<RoomInfo, 'room' | 'secret'>): string => `${siteBase()}/dispatch/#r=${r.room}&k=${r.secret}`;

/** The saved pairing, or null when there is none (or the file is not one, or cannot be decrypted). */
export function loadRoom(file: string, safe: Safe | null): RoomInfo | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const open = (v: unknown): string => (d.enc ? safe!.decryptString(Buffer.from(String(v), 'base64')) : String(v));
    const secret = open(d.secret), pc = open(d.pc);
    if (!parseFragment(`#r=${d.room}&k=${secret}`) || !/^[\w-]{22}$/.test(pc)) return null;
    return { room: d.room, secret, pc, phonePaired: d.phonePaired === true, pairedAt: Number(d.pairedAt) || 0 };
  } catch { return null; }
}

export function saveRoom(file: string, r: RoomInfo, safe: Safe | null): void {
  const enc = !!safe?.isEncryptionAvailable();
  const seal = (v: string): string => (enc ? safe!.encryptString(v).toString('base64') : v);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ room: r.room, secret: seal(r.secret), pc: seal(r.pc), enc, phonePaired: r.phonePaired, pairedAt: r.pairedAt }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

// ── The socket ───────────────────────────────────────────────────────

/** What Link needs of a WebSocket (the `ws` package; a fake in tests). */
export interface Socket {
  binaryType: string; readyState: number;
  onopen: ((e: any) => void) | null; onmessage: ((e: { data: any }) => void) | null;
  onclose: ((e: { code: number }) => void) | null; onerror: ((e: any) => void) | null;
  send(data: string | ArrayBuffer): void; close(): void;
}

export interface LinkEvents {
  phone(on: boolean): void;      // the phone is there with this connection's keys, or left
  msg(m: unknown): void;         // a decrypted message from the phone
  ended(code: number): void;     // the pairing is over (4000 / 4403 / 4404 / 4409)
}

const RETRY_MS = [1000, 2000, 5000, 15000, 30000];
const OPEN = 1;

export class Link {
  private ws: Socket | null = null;
  private keys: DispatchKeys | null = null;
  private ch: Channel | null = null;
  private line: Promise<unknown> = Promise.resolve();    // frames are handled one at a time, in order
  private tries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private over = false;

  /** `open` makes the socket (tests). */
  constructor(readonly info: Pick<RoomInfo, 'room' | 'secret' | 'pc'>, private on: LinkEvents, private open?: (url: string) => Socket) {}

  /** Connects, and reconnects by itself until `unpair()`, `close()` or the room is gone. */
  async connect(): Promise<void> {
    const keys = this.keys ??= await dispatchKeys(this.info.secret, this.info.room, 'pc');
    if (this.over) return;
    const url = `${apiBase().replace(/^http/, 'ws')}/v1/dispatch/room/${this.info.room}?role=pc&auth=${keys.auth}&pc=${this.info.pc}`;
    const ws = this.ws = this.open ? this.open(url) : new WebSocket(url) as unknown as Socket;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.tries = 0; };
    ws.onerror = () => { /* the close that follows decides */ };
    // A socket that is no longer the current one (replaced by a reconnect) changes nothing: its frames are dropped
    // and its close can never end the pairing.
    ws.onmessage = (e) => {
      this.line = this.line.then(() => (this.ws === ws ? this.got(ws, e.data) : undefined))
        .catch(() => { /* not from our phone, another connection's frame, or a replay: dropped */ });
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.over) return;
      this.ws = null;
      this.gone();
      if (endsPairing(e.code)) { this.close(); this.on.ended(e.code); return; }
      this.timer = setTimeout(() => void this.connect(), RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
    };
  }

  private async got(ws: Socket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      const m = JSON.parse(data) as RelayMsg;
      if (m.t !== 'peer') return;                    // unpaired / expired / replaced: the close code that follows decides
      this.gone();
      if (m.on) ws.send(await this.keys!.hello());   // a new connection: new keys, once the phone's hello is here
      return;
    }
    if (isHello(data)) {
      if (this.ch) return;                           // one hello per connection: a second one (a replay) changes nothing
      this.ch = await this.keys!.channel(data);
      this.on.phone(true);
      return;
    }
    if (this.ch) this.on.msg(await this.ch.open(data));
  }

  /** The phone left, or a new connection begins: the old keys are dropped. */
  private gone(): void {
    if (!this.ch) return;
    this.ch = null;
    this.on.phone(false);
  }

  /** True while the phone is there and can be talked to. */
  get phoneOn(): boolean { return !!this.ch; }

  send(msg: PcMsg): void {
    const { ws, ch } = this;
    if (!ws || !ch) return;
    void ch.seal(msg).then((frame) => { if (this.ws === ws && ws.readyState === OPEN) ws.send(frame); }).catch(() => {});
  }

  /** Ends the pairing: the relay tells the phone, closes both sides and never opens the room again. */
  unpair(): void {
    try { if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify({ t: 'unpair' })); } catch { /* offline: the room is dropped here only */ }
    this.close();
  }

  /** Disconnects without unpairing (the app is quitting). */
  close(): void {
    this.over = true;
    clearTimeout(this.timer);
    this.gone();
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}

// ── What a phone message does ────────────────────────────────────────

export interface CoreDeps {
  mode(): 'awake' | 'sleep';
  /** Come online: show Clippy's window and wake him (as the tray's "Wake Up"). */
  wake(): void;
  /** As the right-click menu's "Sleep". */
  sleep(): void;
  /** As clicking Clippy to stop a task. */
  stop(): void;
  /** The same path as a message typed in the bubble; resolves with the reply. */
  run(text: string): Promise<string>;
  resolveApproval(id: string, yes: boolean): boolean;
  track(name: string): void;
  /** False while the phone must not start anything (setup is still open). */
  usable?(): boolean;
}

const MAX_TEXT = 4096;
const okId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

export function createCore(deps: CoreDeps, send: (m: PcMsg) => void) {
  let working = 0;
  const asks = new Map<string, string>();   // the approval cards that are open: only these take a reply
  const state = (): DispatchState => (deps.mode() === 'sleep' ? 'asleep' : working > 0 ? 'working' : 'ready');
  const status = (): void => send({ type: 'status', state: state() });
  const sendAsk = (id: string, question: string): void => send({ type: 'ask', id, question, choices: ['Approve', 'Deny'] });

  /** 'working' while `job` runs (a task from the phone or typed on the PC), then the state after it. */
  async function whileWorking<T>(job: () => Promise<T>): Promise<T> {
    working++; status();
    try { return await job(); } finally { working--; status(); }
  }

  return {
    state, status, whileWorking,
    /** The phone (re)joined: where Clippy is, and what is still waiting for an answer. */
    phoneJoined(): void {
      status();
      for (const [id, q] of asks) sendAsk(id, q);
    },
    ask(id: string, question: string): void { asks.set(id, question); sendAsk(id, question); },
    askDone(id: string): void { if (asks.delete(id)) send({ type: 'ask-done', id }); },
    /** One decrypted message from the phone. Anything that is not a well-formed message is ignored. */
    async onMsg(raw: unknown): Promise<void> {
      const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (m.type === 'reply') {
        if (okId(m.id) && typeof m.yes === 'boolean' && asks.has(m.id)) deps.resolveApproval(m.id, m.yes);
      } else if (m.type === 'stop') {
        deps.stop();
      } else if (deps.usable && !deps.usable()) {
        // setup is open: no task, no wake
      } else if (m.type === 'power') {
        if (m.on === true) deps.wake(); else if (m.on === false) deps.sleep();
      } else if (m.type === 'req') {
        if (!okId(m.id) || typeof m.text !== 'string') return;
        const text = m.text.trim().substring(0, MAX_TEXT);
        if (!text) return;
        const id = m.id;
        deps.track('dispatch_task');
        deps.wake();                                   // online first
        await whileWorking(async () => {
          let reply = '';
          try { reply = await deps.run(text); } catch (err) { log.warn('phone task failed', { err: String(err) }); }
          send({ type: 'answer', text: reply || 'Something went wrong. Try again.', id });
        });
      }
    },
  };
}

// ── The app's one pairing ────────────────────────────────────────────

export interface DispatchStatus {
  state: 'none' | 'waiting' | 'paired';   // no room / QR shown, no phone yet / a phone is paired
  phoneOn: boolean;
  pairedAt: number;
}

export interface InitOptions extends CoreDeps {
  licenseKey(): string;
  /** Tells Settings (when open) that the status changed. */
  notify(status: DispatchStatus): void;
  fetch?: typeof fetch;
  open?: (url: string) => Socket;
  file?: string;
  safe?: Safe | null;
}

let opts: InitOptions | null = null;
let core: ReturnType<typeof createCore> | null = null;
let link: Link | null = null;
let info: RoomInfo | null = null;

const file = (): string => opts?.file ?? path.join(app.getPath('userData'), 'dispatch.json');
const safe = (): Safe | null => (opts && 'safe' in opts ? opts.safe ?? null : safeStorage);

export function getStatus(): DispatchStatus {
  return { state: !info ? 'none' : info.phonePaired ? 'paired' : 'waiting', phoneOn: !!link?.phoneOn, pairedAt: info?.pairedAt ?? 0 };
}
const changed = (): void => { try { opts?.notify(getStatus()); } catch { /* Settings went away */ } };

function forget(): void {
  link = null;
  info = null;
  try { fs.rmSync(file(), { force: true }); } catch { /* best-effort */ }
}

function connect(r: RoomInfo): void {
  info = r;
  const mine: Link = link = new Link(r, {
    phone: (on) => {
      if (link !== mine) return;
      if (on && !r.phonePaired) {
        r.phonePaired = true;
        r.pairedAt = Date.now();
        try { saveRoom(file(), r, safe()); } catch (err) { log.warn('save failed', { err: String(err) }); }
        opts?.track('dispatch_paired');
      }
      if (on) core?.phoneJoined();
      changed();
    },
    msg: (m) => { if (link === mine) void core?.onMsg(m); },
    ended: (code) => {
      if (link !== mine) return;
      log.info('Dispatch.ended', { code });
      forget();
      changed();
    },
  }, opts?.open);
  void mine.connect().catch((err) => log.warn('connect failed', { err: String(err) }));
}

/** After the brain and the main window exist. Connects when a pairing is saved. */
export function initDispatch(o: InitOptions): void {
  shutdownDispatch();
  opts = o;
  core = createCore(o, (m) => link?.send(m));
  const saved = loadRoom(file(), safe());
  if (saved) connect(saved);
}

/** The app is quitting: disconnect, keep the pairing. */
export function shutdownDispatch(): void {
  link?.close();
  link = null;
  info = null;
}

/** Brain mode changed (any source): tell the phone. */
export function modeChanged(): void { core?.status(); }

/** 'working' on the phone while a task typed on the PC runs. */
export function whileWorking<T>(job: () => Promise<T>): Promise<T> {
  return core ? core.whileWorking(job) : job();
}

/** approval.ts shows or settles a card: the phone gets the same question. */
export function approvalEvent(e: { type: 'ask'; id: string; summary: string } | { type: 'done'; id: string }): void {
  if (e.type === 'ask') core?.ask(e.id, e.summary); else core?.askDone(e.id);
}

async function qrFor(r: RoomInfo): Promise<{ url: string; qrDataUrl: string }> {
  const url = qrUrl(r);
  return { url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' }) };
}

/** The current pairing's link again (a lost home-screen icon can be re-added), or null when there is none. */
export async function currentQr(): Promise<{ url: string; qrDataUrl: string } | null> {
  return info ? qrFor(info) : null;
}

/** Makes a new room (the old one is unpaired), registers it and connects. */
export async function pairNew(): Promise<{ url: string; qrDataUrl: string } | { error: string }> {
  if (!opts) return { error: 'Clippy is still starting. Try again in a moment.' };
  const key = opts.licenseKey();
  if (!key) return { error: 'Finish setting up Clippy first, then pair your phone.' };
  const r: RoomInfo = { room: randomB64url(16), secret: randomB64url(32), pc: randomB64url(16), phonePaired: false, pairedAt: 0 };
  let status = 0;
  try {
    const { auth } = await dispatchKeys(r.secret, r.room, 'pc');
    const res = await (opts.fetch ?? fetch)(`${apiBase()}/v1/dispatch/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Client-Version': app.getVersion() },
      body: JSON.stringify({ room: r.room, auth, pcHash: await sha256Hex(r.pc) }),
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
  } catch { /* status 0: not reached */ }
  if (status !== 201 && status !== 200) {
    log.warn('Dispatch.register failed', { status });
    if (status === 0) return { error: 'Could not reach the Clippy server. Check your internet connection and try again.' };
    if (status === 401 || status === 403) return { error: 'Your license could not be checked. Open Settings → License, then try again.' };
    if (status === 429) return { error: 'Too many pairings today. Try again tomorrow.' };
    return { error: `Pairing failed (error ${status}). Try again in a moment.` };
  }
  // Only now, with the new room registered, does the old phone lose its room.
  const old = link;
  forget();
  old?.unpair();
  try { saveRoom(file(), r, safe()); } catch (err) { log.warn('save failed', { err: String(err) }); }
  connect(r);
  changed();
  return qrFor(r);
}

/** "Remove phone". */
export function unpair(): DispatchStatus {
  const old = link;
  forget();
  old?.unpair();
  changed();
  return getStatus();
}
