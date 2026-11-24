// Clippy Dispatch, the phone page: sends tasks to the Clippy on your computer (docs/dispatch-protocol.md).
// The room and the secret come from the link's #fragment, which is never sent to a server. The fragment STAYS in the
// address bar (iPhone "Add to Home Screen" saves the current URL) and is also kept in localStorage as a fallback.
// Every message is end-to-end encrypted before it reaches the relay.
import {
  CLOSE, dispatchKeys, endsPairing, isHello, parseFragment, randomB64url,
  type Channel, type DispatchKeys, type DispatchState, type PcMsg, type PhoneMsg, type RelayMsg,
} from '../src/shared/dispatch-crypto';

declare const __RELAY__: string;   // set at build time: wss://api.clippyai.app, or a local relay for testing

const RETRY_MS = [1000, 2000, 5000, 10000];
const KEEP = 'clippy-dispatch-link';
const DEVICE = 'clippy-dispatch-device';
const ID = /^[\w-]{22}$/;

export interface PhoneLink { room: string; secret: string; dev?: string }

/**
 * The pairing from the address bar's fragment or, when that has none, from the saved link.
 * `d` is this phone's device id: it travels in the link so the home-screen icon (which has its own storage on an
 * iPhone) is the same phone to the relay as the Safari tab that scanned the code.
 */
export function parseLink(hash: string, saved?: string | null): PhoneLink | null {
  for (const h of [hash, saved ?? '']) {
    const l = parseFragment(h);
    if (!l) continue;
    const dev = new URLSearchParams(h.replace(/^#/, '')).get('d') ?? '';
    return ID.test(dev) ? { ...l, dev } : l;
  }
  return null;
}

/** The fragment that goes back into the address bar and into localStorage. */
export const linkHash = (l: PhoneLink): string => `#r=${l.room}&k=${l.secret}${l.dev ? `&d=${l.dev}` : ''}`;

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k: string): void { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

function start(): void {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const app = $('app'), statusEl = $('status'), power = $<HTMLInputElement>('power');
  const notice = $('notice'), noticeText = $('notice-text'), talk = $('talk');
  const taskEl = $('task'), replyEl = $('reply'), askEl = $('ask'), askQ = $('ask-q'), askWhy = $('ask-why');
  const form = $<HTMLFormElement>('form'), text = $<HTMLTextAreaElement>('text'), sendBtn = $<HTMLButtonElement>('send'), stopBtn = $<HTMLButtonElement>('stop');

  const link = parseLink(location.hash, store.get(KEEP));
  if (link) {
    // This phone's id: from the link, else this browser's own, else new. Then the full link goes back into the
    // address bar (so the home-screen icon carries it) and into localStorage.
    const own = store.get(DEVICE) ?? '';
    link.dev ??= ID.test(own) ? own : randomB64url(16);
    store.set(DEVICE, link.dev);
    store.set(KEEP, linkHash(link));
    if (location.hash !== linkHash(link)) history.replaceState(null, '', location.pathname + location.search + linkHash(link));
  }

  let ws: WebSocket | null = null;
  let keys: DispatchKeys | null = null;
  let ch: Channel | null = null;         // this connection's keys; none until both hellos crossed
  let state: DispatchState = 'ready';
  let over = '';                         // why this page can do nothing more
  let elsewhere = false;                 // a newer tab took this phone's place
  const asks = new Map<string, { question: string; reason: string }>();

  function render(): void {
    const pcOn = !!ch;
    app.dataset.state = over ? 'over' : pcOn ? state : 'offline';
    notice.hidden = !over;
    talk.hidden = !!over;
    noticeText.textContent = over;
    statusEl.textContent = over ? '' : elsewhere ? 'Open in another tab' : !pcOn ? 'Offline — PC not connected'
      : state === 'asleep' ? 'Asleep' : state === 'working' ? 'Working…' : 'Ready';
    power.disabled = !pcOn;
    power.checked = pcOn && state !== 'asleep';
    const working = pcOn && state === 'working';
    sendBtn.hidden = working;
    stopBtn.hidden = !working;
    sendBtn.disabled = !pcOn;
    const ask = pcOn ? [...asks.entries()][0] : undefined;
    askEl.hidden = !ask;
    askQ.textContent = ask ? ask[1].question : '';
    askWhy.textContent = ask ? ask[1].reason : '';   // the PC card's warning line
    askWhy.hidden = !(ask && ask[1].reason);
  }

  const send = (msg: PhoneMsg): void => {
    const s = ws;
    void ch?.seal(msg).then((f) => { if (s === ws && s?.readyState === WebSocket.OPEN) s.send(f); }).catch(() => {});
  };

  function got(m: PcMsg): void {
    if (m.type === 'status') state = m.state;
    else if (m.type === 'answer') { replyEl.textContent = m.text; replyEl.hidden = false; }
    else if (m.type === 'ask') asks.set(m.id, { question: m.question, reason: typeof m.reason === 'string' ? m.reason : '' });
    else if (m.type === 'ask-done') asks.delete(m.id);
    render();
  }

  let tries = 0, timer = 0;
  function end(why: string): void {
    over = why;
    ch = null; asks.clear();
    clearTimeout(timer);
    store.del(KEEP);
    render();
  }

  async function connect(): Promise<void> {
    if (!link || over) return;
    const k = keys ??= await dispatchKeys(link.secret, link.room, 'phone');
    if (over || ws) return;
    elsewhere = false;
    const s = ws = new WebSocket(`${__RELAY__}/v1/dispatch/room/${link.room}?role=phone&auth=${k.auth}&dev=${link.dev}`);
    s.binaryType = 'arraybuffer';
    s.onopen = () => { if (ws === s) tries = 0; };
    let line: Promise<unknown> = Promise.resolve();    // frames are handled one at a time, in order
    const frame = async (data: string | ArrayBuffer): Promise<void> => {
      if (ws !== s) return;                            // a socket that is no longer the current one changes nothing
      if (typeof data === 'string') {
        const m = JSON.parse(data) as RelayMsg;
        if (m.t !== 'peer') return;                    // unpaired / expired / replaced: the close code that follows decides
        ch = null; asks.clear();                       // a new connection: new keys, once the computer's hello is here
        render();
        if (m.on) s.send(await k.hello());
      } else if (isHello(data)) {
        if (ch) return;                                // one hello per connection: a second one changes nothing
        ch = await k.channel(data);
        render();
      } else if (ch) got(await ch.open(data));
    };
    s.onmessage = (e) => { line = line.then(() => frame(e.data)).catch(() => { /* not from our computer, or a replay: dropped */ }); };
    s.onclose = (e) => {
      if (ws !== s) return;                            // a stale socket's close never ends the pairing
      ws = null; ch = null;
      if (e.code === CLOSE.taken) return end('Another phone is paired with this Clippy. Pair again from Clippy\'s Settings.');
      if (endsPairing(e.code)) return end('This link was removed. Pair again from Clippy\'s Settings.');
      elsewhere = e.code === CLOSE.replaced;           // a newer tab of this phone: it has the room until this one is opened again
      render();
      if (!elsewhere && !document.hidden) timer = window.setTimeout(connect, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
    };
  }

  if (!link) {
    over = 'Scan the QR code in Clippy\'s Settings → Clippy Dispatch.';
    render();
    return;
  }
  render();
  void connect();
  // Back from the lock screen or another app: reconnect at once.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || ws || over) return;
    clearTimeout(timer);
    void connect();
  });
  // Leaving the page: the computer sees the phone go.
  addEventListener('pagehide', () => { const s = ws; ws = null; ch = null; s?.close(); });

  power.addEventListener('change', () => {
    send({ type: 'power', on: power.checked });
    render();                                          // the switch shows what Clippy says he is, not what was tapped
  });

  function submit(): void {
    const t = text.value.trim();
    if (!t || !ch || state === 'working') return;
    taskEl.textContent = t; taskEl.hidden = false;
    replyEl.textContent = ''; replyEl.hidden = true;
    state = 'working';
    send({ type: 'req', id: randomB64url(6), text: t.slice(0, 4096) });
    text.value = '';
    render();
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  text.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    submit();
  });
  stopBtn.addEventListener('click', () => send({ type: 'stop' }));

  const answer = (yes: boolean): void => {
    const ask = [...asks.keys()][0];
    if (!ask) return;
    send({ type: 'reply', id: ask, yes });
    asks.delete(ask);
    render();
  };
  $('approve').addEventListener('click', () => answer(true));
  $('deny').addEventListener('click', () => answer(false));
}

if (typeof document !== 'undefined') start();
