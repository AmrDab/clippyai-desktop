import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { CLOSE, dispatchKeys, endsPairing, parseFragment, randomB64url, sha256Hex, type PcMsg } from '../src/shared/dispatch-crypto';
import {
  Link, createCore, loadRoom, saveRoom, initDispatch, shutdownDispatch, pairNew, unpair, getStatus, approvalEvent,
  type CoreDeps, type RoomInfo, type Safe, type Socket,
} from '../src/main/dispatch';
import { parseLink, linkHash } from '../dispatch-phone/main';

const room = (): RoomInfo => ({ room: randomB64url(16), secret: randomB64url(32), pc: randomB64url(16), phonePaired: false, pairedAt: 0 });

/** Both sides' channels for one connection. */
async function pairOfChannels(r = room()) {
  const pc = await dispatchKeys(r.secret, r.room, 'pc');
  const phone = await dispatchKeys(r.secret, r.room, 'phone');
  const [h1, h2] = [await pc.hello(), await phone.hello()];
  return { pc, phone, pcCh: await pc.channel(h2), phoneCh: await phone.channel(h1) };
}

describe('dispatch-crypto', () => {
  it('derives the same 43-char relay token on both sides, and ids of the spec sizes', async () => {
    const r = room();
    const pc = await dispatchKeys(r.secret, r.room, 'pc');
    const phone = await dispatchKeys(r.secret, r.room, 'phone');
    expect(pc.auth).toMatch(/^[\w-]{43}$/);
    expect(phone.auth).toBe(pc.auth);
    expect(r.room).toMatch(/^[\w-]{22}$/);
    expect(r.secret).toMatch(/^[\w-]{43}$/);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('round-trips messages in both directions', async () => {
    const { pcCh, phoneCh } = await pairOfChannels();
    expect(await pcCh.open(await phoneCh.seal({ type: 'req', id: 'a', text: 'open Notepad' }))).toEqual({ type: 'req', id: 'a', text: 'open Notepad' });
    expect(await phoneCh.open(await pcCh.seal({ type: 'status', state: 'working' }))).toEqual({ type: 'status', state: 'working' });
  });

  it('rejects a replayed frame', async () => {
    const { pcCh, phoneCh } = await pairOfChannels();
    const frame = await phoneCh.seal({ type: 'stop' });
    await pcCh.open(frame);
    await expect(pcCh.open(frame)).rejects.toThrow();
  });

  it('rejects a tampered frame, and a frame from another connection', async () => {
    const r = room();
    const a = await pairOfChannels(r);
    const frame = new Uint8Array(await a.phoneCh.seal({ type: 'stop' }));
    frame[frame.length - 1] ^= 1;
    await expect(a.pcCh.open(frame.buffer)).rejects.toThrow();
    const b = await pairOfChannels(r);   // same pairing, new nonces: new keys
    await expect(b.pcCh.open(await a.phoneCh.seal({ type: 'stop' }))).rejects.toThrow();
  });

  it('rejects a forged hello and its own hello sent back', async () => {
    const r = room();
    const pc = await dispatchKeys(r.secret, r.room, 'pc');
    const mine = await pc.hello();
    await expect(pc.channel(mine)).rejects.toThrow();
    const stranger = await dispatchKeys(randomB64url(32), r.room, 'phone');
    await pc.hello();
    await expect(pc.channel(await stranger.hello())).rejects.toThrow();
  });

  it('only 4000 / 4403 / 4404 / 4409 end a pairing', () => {
    expect([4000, 4403, 4404, 4409].every(endsPairing)).toBe(true);
    expect([CLOSE.replaced, CLOSE.rate, 1000, 1006].some(endsPairing)).toBe(false);
  });
});

describe('phone message handling (createCore)', () => {
  function setup(over: Partial<CoreDeps> = {}) {
    let mode: 'awake' | 'sleep' = 'sleep';
    const sent: PcMsg[] = [];
    const deps = {
      mode: () => mode,
      wake: vi.fn(() => { mode = 'awake'; }),
      sleep: vi.fn(() => { mode = 'sleep'; }),
      stop: vi.fn(),
      run: vi.fn(async (t: string) => `done: ${t}`),
      resolveApproval: vi.fn(() => true),
      track: vi.fn(),
      ...over,
    };
    return { deps, sent, core: createCore(deps, (m) => sent.push(m)) };
  }

  it('req: wakes Clippy, runs the text like a typed message, answers, then is ready', async () => {
    const { deps, sent, core } = setup();
    await core.onMsg({ type: 'req', id: 'r1', text: '  open Notepad  ' });
    expect(deps.wake).toHaveBeenCalledTimes(1);
    expect(deps.run).toHaveBeenCalledWith('open Notepad');
    expect(deps.wake.mock.invocationCallOrder[0]).toBeLessThan(deps.run.mock.invocationCallOrder[0]);
    expect(sent).toEqual([
      { type: 'status', state: 'working' },
      { type: 'answer', text: 'done: open Notepad', id: 'r1' },
      { type: 'status', state: 'ready' },
    ]);
    expect(deps.track).toHaveBeenCalledWith('dispatch_task');   // the name only: no text
    expect(deps.track.mock.calls.flat().join(' ')).not.toContain('Notepad');
  });

  it('req: text is cut to 4096 chars; a failed run still answers', async () => {
    const { deps, core } = setup();
    await core.onMsg({ type: 'req', id: 'r1', text: 'x'.repeat(10_000) });
    expect(deps.run.mock.calls[0][0]).toHaveLength(4096);
    const failing = setup({ run: vi.fn(async () => { throw new Error('boom'); }) });
    await failing.core.onMsg({ type: 'req', id: 'r2', text: 'hi' });
    expect(failing.sent.find((m) => m.type === 'answer')).toMatchObject({ id: 'r2' });
    expect(failing.sent.at(-1)).toEqual({ type: 'status', state: 'ready' });
  });

  it('power: on wakes, off sleeps', async () => {
    const { deps, core } = setup();
    await core.onMsg({ type: 'power', on: true });
    expect(deps.wake).toHaveBeenCalledTimes(1);
    await core.onMsg({ type: 'power', on: false });
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(core.state()).toBe('asleep');
  });

  it('stop: stops the running task', async () => {
    const { deps, core } = setup();
    await core.onMsg({ type: 'stop' });
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it('ask / reply: only an open ask takes a reply; open asks are sent again when the phone rejoins', async () => {
    const { deps, sent, core } = setup();
    await core.onMsg({ type: 'reply', id: 'a1', yes: true });   // nothing is open
    expect(deps.resolveApproval).not.toHaveBeenCalled();
    core.ask('a1', 'Run `ls`');
    expect(sent.at(-1)).toEqual({ type: 'ask', id: 'a1', question: 'Run `ls`', choices: ['Approve', 'Deny'] });
    sent.length = 0;
    core.phoneJoined();
    expect(sent).toEqual([{ type: 'status', state: 'asleep' }, { type: 'ask', id: 'a1', question: 'Run `ls`', choices: ['Approve', 'Deny'] }]);
    await core.onMsg({ type: 'reply', id: 'a1', yes: 'yes' });   // not a boolean
    expect(deps.resolveApproval).not.toHaveBeenCalled();
    await core.onMsg({ type: 'reply', id: 'a1', yes: false });
    expect(deps.resolveApproval).toHaveBeenCalledWith('a1', false);
    core.askDone('a1');
    expect(sent.at(-1)).toEqual({ type: 'ask-done', id: 'a1' });
    core.askDone('a1');                                          // once only
    expect(sent.filter((m) => m.type === 'ask-done')).toHaveLength(1);
  });

  it('ignores unknown, malformed and oversized messages', async () => {
    const { deps, sent, core } = setup();
    for (const m of [null, 'req', 42, {}, { type: 'nope' }, { type: 'req', id: 'r', text: 123 }, { type: 'req', id: 'r', text: '   ' },
      { type: 'req', id: 'x'.repeat(65), text: 'hi' }, { type: 'req', text: 'hi' }, { type: 'power', on: 'yes' }, { type: 'reply', id: 'x'.repeat(65), yes: true }]) {
      await core.onMsg(m);
    }
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.resolveApproval).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('while setup is open the phone starts nothing', async () => {
    const { deps, core } = setup({ usable: () => false });
    await core.onMsg({ type: 'req', id: 'r', text: 'hi' });
    await core.onMsg({ type: 'power', on: true });
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });
});

// ── persistence + the socket ─────────────────────────────────────────

const fakeSafe = (available = true): Safe => ({
  isEncryptionAvailable: () => available,
  encryptString: (t) => Buffer.from(`ENC(${Buffer.from(t).toString('hex')})`),
  decryptString: (b) => Buffer.from(b.toString().slice(4, -1), 'hex').toString(),
});

class FakeSocket implements Socket {
  binaryType = ''; readyState = 1; sent: Array<string | ArrayBuffer> = []; closed = false;
  onopen: Socket['onopen'] = null; onmessage: Socket['onmessage'] = null; onclose: Socket['onclose'] = null; onerror: Socket['onerror'] = null;
  constructor(readonly url: string) {}
  send(d: string | ArrayBuffer) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
}

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-dispatch-')); });
afterEach(() => { shutdownDispatch(); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('saved pairing', () => {
  it('never stores the secret or the PC token in plain text when safeStorage is available', () => {
    const file = path.join(dir, 'dispatch.json');
    const r = { ...room(), phonePaired: true, pairedAt: 1234 };
    saveRoom(file, r, fakeSafe());
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(r.secret);
    expect(raw).not.toContain(r.pc);
    expect(raw).toContain(r.room);
    expect(loadRoom(file, fakeSafe())).toEqual(r);
  });

  it('falls back to a plain file without safeStorage, and returns null for a missing or broken file', () => {
    const file = path.join(dir, 'dispatch.json');
    const r = room();
    saveRoom(file, r, fakeSafe(false));
    expect(loadRoom(file, null)).toEqual(r);
    saveRoom(file, r, null);
    expect(loadRoom(file, null)).toEqual(r);
    expect(loadRoom(path.join(dir, 'none.json'), null)).toBeNull();
    fs.writeFileSync(file, '{"room":"x"}');
    expect(loadRoom(file, null)).toBeNull();
    saveRoom(file, r, fakeSafe());
    expect(loadRoom(file, { ...fakeSafe(), decryptString: () => { throw new Error('other user'); } })).toBeNull();
  });
});

function initWith(over: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const notify = vi.fn();
  const track = vi.fn();
  const file = path.join(dir, 'dispatch.json');
  initDispatch({
    mode: () => 'awake', wake: vi.fn(), sleep: vi.fn(), stop: vi.fn(), run: vi.fn(async () => 'ok'), resolveApproval: vi.fn(() => true),
    track, notify, licenseKey: () => 'CLIPPY-TEST', file, safe: fakeSafe(),
    open: (url: string) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    fetch: (async () => ({ status: 201 })) as unknown as typeof fetch,
    ...over,
  });
  return { sockets, notify, track, file };
}

describe('Link + the app pairing', () => {
  it('a stale socket can never end the pairing; 4001 reconnects; only the current socket\'s 4404 ends it', async () => {
    const file = path.join(dir, 'dispatch.json');
    saveRoom(file, { ...room(), phonePaired: true, pairedAt: 1 }, fakeSafe());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sockets, notify } = initWith();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0].url).toMatch(/^wss:\/\/api\.clippyai\.app\/v1\/dispatch\/room\/[\w-]{22}\?role=pc&auth=[\w-]{43}&pc=[\w-]{22}$/);
    expect(getStatus().state).toBe('paired');

    // The connection drops (not an end code): a new socket after the back-off.
    sockets[0].onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    // The old socket now reports "gone": it is no longer the current one, so nothing happens.
    sockets[0].onmessage!({ data: JSON.stringify({ t: 'expired' }) });
    sockets[0].onclose!({ code: CLOSE.gone });
    expect(fs.existsSync(file)).toBe(true);
    expect(getStatus().state).toBe('paired');

    // Replaced by a newer socket of this PC (4001): not the end, it reconnects.
    sockets[1].onopen!({});
    sockets[1].onmessage!({ data: JSON.stringify({ t: 'replaced' }) });
    sockets[1].onclose!({ code: CLOSE.replaced });
    expect(fs.existsSync(file)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(sockets).toHaveLength(3));

    // The current socket's 4404 is the end: the file goes and Settings hears of it.
    sockets[2].onclose!({ code: CLOSE.gone });
    expect(fs.existsSync(file)).toBe(false);
    expect(getStatus().state).toBe('none');
    expect(notify).toHaveBeenLastCalledWith({ state: 'none', phoneOn: false, pairedAt: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(3);   // no reconnect after the end
  });

  it('a Link ignores frames and closes of a socket it has replaced', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sockets: FakeSocket[] = [];
    const ended = vi.fn();
    const link = new Link(room(), { phone: vi.fn(), msg: vi.fn(), ended }, (url) => { const s = new FakeSocket(url); sockets.push(s); return s; });
    await link.connect();
    sockets[0].onclose!({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[0].onclose!({ code: CLOSE.unpaired });
    expect(ended).not.toHaveBeenCalled();
    sockets[1].onclose!({ code: CLOSE.taken });
    expect(ended).toHaveBeenCalledWith(CLOSE.taken);
    link.close();
  });

  it('pairNew: registers the room with the license key, saves it encrypted and returns the QR link', async () => {
    const fetchFn = vi.fn(async () => ({ status: 201 }));
    const { sockets, file } = initWith({ fetch: fetchFn });
    const r = await pairNew();
    if ('error' in r) throw new Error(r.error);
    const link = parseFragment(new URL(r.url).hash)!;
    expect(r.url.startsWith('https://clippyai.app/dispatch/#r=')).toBe(true);
    expect(r.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.clippyai.app/v1/dispatch/rooms');
    expect(init.headers.Authorization).toBe('Bearer CLIPPY-TEST');
    expect(init.headers['X-Client-Version']).toBe('0.0.0-test');
    const body = JSON.parse(init.body);
    expect(body.room).toBe(link.room);
    expect(body.auth).toMatch(/^[\w-]{43}$/);
    expect(body.pcHash).toMatch(/^[0-9a-f]{64}$/);
    expect(init.body).not.toContain(link.secret);          // the secret never goes to the server
    expect(fs.readFileSync(file, 'utf8')).not.toContain(link.secret);
    expect(getStatus().state).toBe('waiting');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    // A second pairing replaces the first: the old room is unpaired, the new one is saved.
    const second = await pairNew();
    if ('error' in second) throw new Error(second.error);
    expect(sockets[0].sent).toContain(JSON.stringify({ t: 'unpair' }));
    expect(sockets[0].closed).toBe(true);
    sockets[0].onclose!({ code: CLOSE.unpaired });           // the old socket's close must not delete the new pairing
    expect(loadRoom(file, fakeSafe())!.room).toBe(parseFragment(new URL(second.url).hash)!.room);

    expect(unpair().state).toBe('none');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('pairNew: a clear error without a license or when the server refuses; the old pairing stays', async () => {
    initWith({ licenseKey: () => '' });
    expect(await pairNew()).toEqual({ error: expect.stringMatching(/setting up/i) });
    const file = path.join(dir, 'dispatch.json');
    saveRoom(file, { ...room(), phonePaired: true, pairedAt: 1 }, fakeSafe());
    initWith({ fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    expect(await pairNew()).toEqual({ error: expect.stringMatching(/reach/i) });
    expect(getStatus().state).toBe('paired');
    initWith({ fetch: (async () => ({ status: 401 })) as unknown as typeof fetch });
    expect(await pairNew()).toEqual({ error: expect.stringMatching(/license/i) });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('end to end over fake sockets: the phone joins, sends a task and gets the answer; the first join marks it paired', async () => {
    const r = room();
    const file = path.join(dir, 'dispatch.json');
    saveRoom(file, r, fakeSafe());
    const run = vi.fn(async () => 'All done.');
    const { sockets, track } = initWith({ run });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const s = sockets[0];
    const phone = await dispatchKeys(r.secret, r.room, 'phone');

    s.onmessage!({ data: JSON.stringify({ t: 'peer', on: true }) });
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));           // the PC's hello
    const myHello = await phone.hello();
    const ch = await phone.channel(s.sent[0] as ArrayBuffer);
    s.onmessage!({ data: myHello });
    await vi.waitFor(() => expect(getStatus()).toMatchObject({ state: 'paired', phoneOn: true }));
    expect(track).toHaveBeenCalledWith('dispatch_paired');
    expect(loadRoom(file, fakeSafe())!.phonePaired).toBe(true);

    approvalEvent({ type: 'ask', id: 'a1', summary: 'Delete notes.txt' });
    s.onmessage!({ data: await ch.seal({ type: 'req', id: 'r1', text: 'tidy my desktop' }) });
    await vi.waitFor(() => expect(s.sent.length).toBeGreaterThanOrEqual(6));
    const got = [];
    for (const f of s.sent.slice(1)) got.push(await ch.open(f as ArrayBuffer));
    expect(got).toEqual([
      { type: 'status', state: 'ready' },
      { type: 'ask', id: 'a1', question: 'Delete notes.txt', choices: ['Approve', 'Deny'] },
      { type: 'status', state: 'working' },
      { type: 'answer', text: 'All done.', id: 'r1' },
      { type: 'status', state: 'ready' },
    ]);
    expect(run).toHaveBeenCalledWith('tidy my desktop');

    s.onmessage!({ data: JSON.stringify({ t: 'peer', on: false }) });
    await vi.waitFor(() => expect(getStatus().phoneOn).toBe(false));
  });
});

describe('phone page link', () => {
  const R = 'A'.repeat(22), K = 'b'.repeat(43), D = 'd'.repeat(22);

  it('reads the room and the secret from the fragment', () => {
    expect(parseLink(`#r=${R}&k=${K}`)).toEqual({ room: R, secret: K });
    expect(parseLink(`r=${R}&k=${K}&d=${D}`)).toEqual({ room: R, secret: K, dev: D });
    expect(parseLink(`#r=${R}&k=${K}&d=short`)).toEqual({ room: R, secret: K });
  });

  it('uses the saved link when the page opens without a fragment; the fragment wins when both are there', () => {
    expect(parseLink('', `#r=${R}&k=${K}&d=${D}`)).toEqual({ room: R, secret: K, dev: D });
    expect(parseLink(`#r=${'Z'.repeat(22)}&k=${K}`, `#r=${R}&k=${K}`)!.room).toBe('Z'.repeat(22));
  });

  it('returns null for no link or a broken one', () => {
    expect(parseLink('')).toBeNull();
    expect(parseLink('', null)).toBeNull();
    expect(parseLink('#r=short&k=short', '#nothing')).toBeNull();
    expect(parseLink(`#r=${R}`)).toBeNull();
  });

  it('linkHash writes the link back as it was read', () => {
    expect(linkHash({ room: R, secret: K })).toBe(`#r=${R}&k=${K}`);
    expect(parseLink(linkHash({ room: R, secret: K, dev: D }))).toEqual({ room: R, secret: K, dev: D });
  });
});
