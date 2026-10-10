/**
 * games.ts — v0.21
 *
 * Local mini-games (Catch, Hide-and-seek, Rock-paper-scissors). 100 % local:
 * no model turns, free on every plan. Module-level singleton like follow-me.
 *
 *  - Catch uses a full-screen transparent overlay window (game-overlay.html)
 *    on the display Clippy sits on; the overlay owns the ball + physics and
 *    reports where it came to rest. Main glides Clippy's window there, plays
 *    the pickup animation, carries the ball home (overlay draws it riding on
 *    him) and arms the next throw.
 *  - Hide-and-seek and RPS need no overlay — they drive Clippy's own window
 *    and bubble (game-say / game-prompt IPC → renderer main.ts).
 *
 * Geometry is anchor-based: Clippy's sprite is pinned to the window's
 * BOTTOM-RIGHT corner (window.ts), so every move targets that corner and
 * stays correct whether or not the bubble is open. All values are DIP.
 */

import { BrowserWindow, screen, ipcMain } from 'electron';
import path from 'path';
import { createLogger } from './logger';
import * as followMe from './follow-me';
import * as windowFollow from './window-follow';
import {
  GameKind, parseGameIntent, rpsOutcome, rpsSeriesOver, RPS_PICKS, RPS_EMOJI, RpsPick,
  originForAnchor, easeStep, pickHideSpot, hideReaction, catchReaction, Rect,
} from './games-logic';

const log = createLogger('Games');

type Point = { x: number; y: number };

let _win: BrowserWindow | null = null;
let _overlay: BrowserWindow | null = null;
let _game: GameKind | null = null;
let _onChange: (() => void) | null = null;
let _home: Point | null = null;
let _wa: Rect | null = null;
let _reduced = false;
let _glide: ReturnType<typeof setInterval> | null = null;
let _timers: ReturnType<typeof setTimeout>[] = [];

// Catch
let _streak = 0;
let _catchBusy = false; // gliding to / carrying the ball
// Hide-and-seek
let _hiddenAt = 0;
let _hidePhase: 'hiding' | 'hidden' | 'found' = 'hiding';
// RPS
let _score = { user: 0, clippy: 0, rounds: 0 };

const GLIDE_MS = 16;
const HIDE_GIVE_UP_MS = 60_000;

// ── Wiring ───────────────────────────────────────────────────────────────────

let _ipcRegistered = false;
export function setMainWindow(win: BrowserWindow): void {
  _win = win;
  if (_ipcRegistered) return;
  _ipcRegistered = true;
  ipcMain.handle('game-action', (_e, value: unknown) => {
    if (typeof value === 'string') handleAction(value);
  });
  ipcMain.on('game-overlay:ready', () => sendOverlayInit());
  ipcMain.on('game-overlay:ignore-mouse', (_e, ignore: boolean) => {
    if (_overlay && !_overlay.isDestroyed()) _overlay.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('game-overlay:ball-rest', (_e, p: { x: number; y: number; r: number; speed: number; distance: number; weak: boolean }) => {
    if (_game === 'catch') onBallRest(p);
  });
  ipcMain.on('game-overlay:stop', () => stop('esc'));
}

/** Tray menu re-render hook. */
export function onStateChange(cb: () => void): void { _onChange = cb; }
export function isActive(): boolean { return _game !== null; }
export function activeGame(): GameKind | null { return _game; }

export const GAME_LABELS: Record<GameKind, string> = {
  catch: 'Catch', hide: 'Hide-and-seek', rps: 'Rock-paper-scissors',
};

// ── Chat routing (called by brain.handleUserMessage before any network turn) ─

/** Returns the reply text if the message was a game phrase, else null. */
export function routeMessage(text: string): string | null {
  const intent = parseGameIntent(text, isActive());
  if (!intent) return null;
  log.info('Game.intent', { intent, text: text.slice(0, 60) });
  if (intent.kind === 'stop') { stop('voice'); return 'Thanks for playing! 📎'; }
  if (intent.kind === 'menu') { offerMenu(); return 'Want to play? Pick a game!'; }
  return start(intent.game, 'voice');
}

function offerMenu(): void {
  prompt('Want to play? Pick a game:', [
    { label: '🎾 Catch', value: 'start:catch' },
    { label: '🙈 Hide-and-seek', value: 'start:hide' },
    { label: '✊ Rock-paper-scissors', value: 'start:rps' },
  ], 'GetAttention');
}

// ── Start / stop ─────────────────────────────────────────────────────────────

export function start(game: GameKind, trigger: string): string {
  if (!_win || _win.isDestroyed()) return "I can't play right now.";
  if (_game) stop('switch');
  followMe.stop('game');
  _game = game;
  _wa = screen.getDisplayMatching(_win.getBounds()).workArea;
  // Keep the previous home if a restart caught us mid-glide back to it.
  _home = _home ?? anchorOf(_win);
  log.info('Game.start', { game, trigger });
  _onChange?.();
  send('game-state', { game });

  void _win.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches")
    .then((v) => { _reduced = !!v; }).catch(() => { _reduced = false; });

  switch (game) {
    case 'catch': return startCatch();
    case 'hide': return startHide();
    case 'rps': return startRps();
  }
}

export function stop(reason: string): void {
  if (!_game) return;
  const game = _game;
  log.info('Game.stop', { game, reason });
  clearTimers();
  stopGlide();
  destroyOverlay();
  _game = null;
  _catchBusy = false;
  send('game-state', { game: null });
  _onChange?.();
  if (reason !== 'switch' && reason !== 'finished') {
    say('Thanks for playing! 📎', 'Wave');
  }
  if (_home && game !== 'rps') glideTo(_home, () => { _home = null; });
  else _home = null;
}

/** Bubble button / renderer events: 'start:<game>', 'rps:<pick>', 'found', 'stop:<reason>', 'again', 'done'. */
export function handleAction(value: string): void {
  if (value.startsWith('start:')) { start(value.slice(6) as GameKind, 'menu'); return; }
  if (value.startsWith('stop:')) { stop(value.slice(5)); return; }
  if (value === 'done') { stop('finished'); say('Good game! 📎', 'Wave'); return; }
  if (value === 'again' && _game) { const g = _game; stop('switch'); start(g, 'again'); return; }
  if (value === 'giveup' && _game === 'hide') { giveUpHide(); return; }
  if (value === 'found' && _game === 'hide') { onFound(); return; }
  if (value.startsWith('rps:') && _game === 'rps') { onRpsPick(value.slice(4) as RpsPick); return; }
}

// ── Catch ────────────────────────────────────────────────────────────────────

function startCatch(): string {
  _streak = 0;
  createOverlay();
  const text = 'Catch! Grab the ball and fling it — I\'ll fetch it. Esc or "stop" ends the game. 📎';
  speak(text, 'GetAttention');
  return text;
}

function createOverlay(): void {
  destroyOverlay();
  if (!_wa) return;
  _overlay = new BrowserWindow({
    x: _wa.x, y: _wa.y, width: _wa.width, height: _wa.height,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false, hasShadow: false, focusable: false,
    backgroundColor: '#00000000', show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  _overlay.setAlwaysOnTop(true, 'screen-saver');
  // Click-through everywhere except over the ball (renderer toggles it).
  _overlay.setIgnoreMouseEvents(true, { forward: true });
  if (process.env.ELECTRON_RENDERER_URL) {
    _overlay.loadURL(`${process.env.ELECTRON_RENDERER_URL}/game-overlay.html`);
  } else {
    _overlay.loadFile(path.join(__dirname, '../renderer/game-overlay.html'));
  }
  _overlay.on('closed', () => { _overlay = null; });
}

function destroyOverlay(): void {
  if (_overlay && !_overlay.isDestroyed()) _overlay.destroy();
  _overlay = null;
}

function sendOverlayInit(): void {
  if (!_overlay || _overlay.isDestroyed() || !_win || !_wa) return;
  _overlay.showInactive();
  _win.moveTop(); // Clippy stays above the ball
  toOverlay('game-overlay:init', { wa: _wa, anchor: anchorOf(_win), reducedMotion: _reduced });
}

function onBallRest(p: { x: number; y: number; r: number; speed: number; distance: number; weak: boolean }): void {
  if (!_win || !_wa || _catchBusy) return;
  if (p.weak) {
    say(['That\'s it? Put some arm into it! 📎', 'A toss, not a nudge! 📎', 'My grandma throws harder! 📎'][Math.floor(Math.random() * 3)], 'GestureDown');
    toOverlay('game-overlay:ball-ready', { anchor: anchorOf(_win) });
    return;
  }
  _catchBusy = true;
  const wa = _wa;
  // Put the ball under the sprite's bottom-center.
  const target = { x: wa.x + p.x + 70, y: wa.y + p.y + p.r };
  glideTo(target, () => {
    if (_game !== 'catch' || !_win) return;
    send('play-animation', 'GestureDown');
    after(600, () => {
      if (_game !== 'catch' || !_win || !_home) return;
      toOverlay('game-overlay:carry', { anchor: anchorOf(_win) });
      glideTo(_home, () => {
        if (_game !== 'catch' || !_win) return;
        _streak += 1;
        _catchBusy = false;
        const r = catchReaction(_streak);
        say(r.text, r.animate);
        toOverlay('game-overlay:carry', { anchor: null });
        toOverlay('game-overlay:ball-ready', { anchor: anchorOf(_win) });
      }, (anchor) => toOverlay('game-overlay:carry', { anchor }));
    });
  });
}

// ── Hide-and-seek ────────────────────────────────────────────────────────────

function startHide(): string {
  _hidePhase = 'hiding';
  const text = 'Close your eyes and count to ten… I\'m hiding! Click me when you find me. 📎';
  speak(text, 'Hide', true);
  // Collapse the bubble first; the renderer→main resize round-trip must land
  // before we read the window size, or the later collapse would restore the
  // pre-hide origin and yank him out of his spot.
  after(1800, () => send('game-say', { hideBubble: true }));
  after(2200, () => {
    if (_game !== 'hide' || !_win || !_wa) return;
    stopGlide();
    const [w, h] = _win.getSize();
    const spot = pickHideSpot(_wa, { width: w, height: h });
    _win.setBounds(spot);
    windowFollow.noteManualMove();
    // 'Hide' ends with him fully tucked into the paper — reappear so the
    // on-screen 30–55 % is actually him, peeking toward the middle.
    send('play-animation', 'Show');
    const wa = _wa;
    const peek = spot.x < wa.x ? 'LookRight' : spot.x + w > wa.x + wa.width ? 'LookLeft' : 'LookUp';
    after(1200, () => { if (_game === 'hide' && _hidePhase === 'hidden') send('play-animation', peek); });
    _hiddenAt = Date.now();
    _hidePhase = 'hidden';
    // macOS window-follow honours a 30 s manual-move cooldown; re-note so it
    // can't drag him out of hiding before the 60 s auto-reveal.
    after(25_000, () => windowFollow.noteManualMove());
    after(50_000, () => windowFollow.noteManualMove());
    after(HIDE_GIVE_UP_MS, () => { if (_game === 'hide' && _hidePhase === 'hidden') giveUpHide(); });
  });
  return text;
}

function onFound(): void {
  if (_hidePhase !== 'hidden' || !_home) return;
  _hidePhase = 'found';
  const elapsed = Date.now() - _hiddenAt;
  const home = _home;
  send('play-animation', 'Show');
  glideTo(home, () => {
    const r = hideReaction(elapsed);
    prompt(r.text + ' Again?', [{ label: 'Hide again', value: 'again' }, { label: 'Done', value: 'done' }], r.animate);
  });
}

function giveUpHide(): void {
  if (_hidePhase !== 'hidden' || !_home) return;
  _hidePhase = 'found';
  const home = _home;
  send('play-animation', 'Show');
  glideTo(home, () => {
    prompt('Here I am! You gave up? Another round? 📎', [{ label: 'Hide again', value: 'again' }, { label: 'Done', value: 'done' }], 'Wave');
  });
}

// ── Rock-paper-scissors ──────────────────────────────────────────────────────

const RPS_ACTIONS = RPS_PICKS.map((p) => ({ label: `${RPS_EMOJI[p]} ${p[0].toUpperCase()}${p.slice(1)}`, value: `rps:${p}` }));

function startRps(): string {
  _score = { user: 0, clippy: 0, rounds: 0 };
  const text = 'Rock, paper, scissors — best of 3! Pick one:';
  prompt(text, RPS_ACTIONS, 'GetAttention');
  return text;
}

function onRpsPick(user: RpsPick): void {
  if (!RPS_PICKS.includes(user)) return;
  const clippy = RPS_PICKS[Math.floor(Math.random() * 3)];
  const outcome = rpsOutcome(user, clippy);
  _score.rounds += 1;
  if (outcome === 'win') _score.user += 1;
  if (outcome === 'lose') _score.clippy += 1;
  send('game-say', { text: 'Rock… paper… scissors…', animate: 'Thinking' });
  after(_reduced ? 300 : 900, () => {
    if (_game !== 'rps') return;
    const line = outcome === 'win' ? 'you take this one!' : outcome === 'lose' ? 'mine!' : 'tie!';
    const head = `You ${RPS_EMOJI[user]} · Me ${RPS_EMOJI[clippy]} — ${line} (You ${_score.user} · Me ${_score.clippy})`;
    if (rpsSeriesOver(_score)) {
      const final = _score.user > _score.clippy ? 'You win the series! Rematch? 📎'
        : _score.user < _score.clippy ? 'I win the series! Rematch? 📎' : 'A draw! Rematch? 📎';
      prompt(`${head}\n${final}`, [{ label: 'Rematch', value: 'again' }, { label: 'Done', value: 'done' }],
        _score.user === _score.clippy ? 'Wave' : 'Congratulate');
    } else {
      prompt(`${head} Next:`, RPS_ACTIONS, outcome === 'win' ? 'Alert' : outcome === 'lose' ? 'GetAttention' : 'Explain');
    }
  });
}

// ── Window gliding (follow-me easing, anchor space) ──────────────────────────

function anchorOf(win: BrowserWindow): Point {
  const b = win.getBounds();
  return { x: b.x + b.width, y: b.y + b.height };
}

function glideTo(target: Point, onArrive: () => void, onTick?: (anchor: Point) => void): void {
  stopGlide();
  if (!_win || _win.isDestroyed() || !_wa) return;
  const win = _win;
  const wa = _wa;
  let cur = anchorOf(win);
  const factor = _reduced ? 0.35 : 0.16;
  _glide = setInterval(() => {
    if (win.isDestroyed()) { stopGlide(); return; }
    const next = easeStep(cur, target, factor);
    cur = { x: next.x, y: next.y };
    const [w, h] = win.getSize();
    const rect = originForAnchor({ x: Math.round(cur.x), y: Math.round(cur.y) }, { width: w, height: h }, wa);
    if (Number.isFinite(rect.x) && Number.isFinite(rect.y)) win.setBounds(rect);
    windowFollow.noteManualMove();
    onTick?.(anchorOf(win));
    if (next.arrived) { stopGlide(); onArrive(); }
  }, GLIDE_MS);
}

function stopGlide(): void {
  if (_glide) { clearInterval(_glide); _glide = null; }
}

// ── Renderer messaging ───────────────────────────────────────────────────────

/** Bubble text + animation, no TTS (games are chatty; voice only on start). */
function say(text: string, animate?: string): void {
  send('game-say', { text, animate });
}

/** Spoken (TTS) line — used once per game start. */
function speak(text: string, animate: string, noTts = false): void {
  if (noTts) say(text, animate);
  else send('clippy-speak', { text, animate });
}

function prompt(text: string, actions: Array<{ label: string; value: string }>, animate?: string): void {
  send('game-prompt', { text, actions, animate });
}

function send(channel: string, payload?: unknown): void {
  if (!_win || _win.isDestroyed()) return;
  _win.webContents.send(channel, payload);
}

function toOverlay(channel: string, payload?: unknown): void {
  if (!_overlay || _overlay.isDestroyed()) return;
  _overlay.webContents.send(channel, payload);
}

function after(ms: number, fn: () => void): void {
  const t = setTimeout(() => { _timers = _timers.filter((x) => x !== t); fn(); }, ms);
  _timers.push(t);
}

function clearTimers(): void {
  for (const t of _timers) clearTimeout(t);
  _timers = [];
}
