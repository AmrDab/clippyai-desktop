import { Recorder } from './recorder';

// v0.12.3 — auto-hide is now configurable via Settings.bubbleAutoHideMs.
// 0 = "Manual" (never auto-hide). Default 30000 (was 20000 — 20s stole long
// replies mid-read per UX audit finding #4).
const DEFAULT_AUTO_HIDE_MS = 30000;
// v0.12.3 — typewriter speeds up when text is long so TTS doesn't finish
// 5s before the bubble. 25ms/char on a 200-char tip = 5s typing while TTS
// finishes in ~3s. Per UX audit finding #1.
const TYPE_INTERVAL_FAST_MS = 10;  // for replies > 80 chars
const TYPE_INTERVAL_NORMAL_MS = 18; // for short replies (still feels alive)

// v0.19.0 PR-2 — state machine + tint system. Compact = ambient one-liner
// (auto-fades, no input). Standard = the v0.12 behavior; default for any
// reply or any text > 80 chars. Expanded = full chat panel with history,
// chips, and a larger input row.
export type BubbleState = 'compact' | 'standard' | 'expanded';
export type BubbleTint  = 'default' | 'info' | 'warning' | 'busy' | 'error' | 'success';
export type DefaultBubbleState = 'compact' | 'standard';

// Short ambient tips render in compact unless the caller forces standard.
// Threshold matches the 80-char split used for typewriter speed elsewhere.
const COMPACT_TEXT_THRESHOLD = 80;

// Smart-avoidance — slide ~120px in the opposite direction when the cursor
// closes to within this distance. Re-checked on every cursor pump; the
// state is debounced via requestAnimationFrame so we don't thrash transforms.
const AVOIDANCE_RADIUS_PX = 90;
const AVOIDANCE_RELEASE_PX = 220; // hysteresis — cursor must leave further than entry

interface ChatMessage {
  role: 'user' | 'clippy' | 'system';
  text: string;
  time: Date;
}

export interface SuggestionChip {
  label: string;
  /** Free-form action string passed back through onSend. PR-3 will route
   *  this through a contextual-suggestion engine; PR-2 ships the render
   *  contract only, so the action is just user text. */
  action: string;
}

interface BubbleActionButton {
  label: string;
  /** Optional handler. If omitted, clicking the button sends `label` as
   *  user text — same pattern as a chip but rendered inline with the tip. */
  onClick?: () => void;
  /** Optional style hint — "primary" gets the accent fill, anything else
   *  is a quieter outline. */
  variant?: 'primary' | 'ghost';
}

export class BubbleController {
  private bubble: HTMLElement;
  private bubbleText: HTMLElement;
  private actionsArea: HTMLElement;
  private history: HTMLElement;
  private chips: HTMLElement;
  private inputArea: HTMLElement;
  private input: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private micBtn: HTMLButtonElement | null;
  private micLevel: HTMLElement | null;
  private attachBtn: HTMLButtonElement | null;
  private expandHandle: HTMLButtonElement | null;
  private header: HTMLElement;
  private minimizeBtn: HTMLButtonElement | null;
  private pinBtn: HTMLButtonElement | null;
  private closeBtn: HTMLButtonElement | null;
  private onSend: (text: string) => void;
  private typeTimer: number | null = null;
  private hideTimer: number | null = null;
  private hintTimer: number | null = null;
  private chatHistory: ChatMessage[] = [];
  private showingHistory: boolean = false;
  // v0.12.3 — runtime-configurable auto-hide. 0 = manual / never auto-hide.
  private autoHideMs: number = DEFAULT_AUTO_HIDE_MS;
  // v0.17.0 — voice input.
  private recorder: Recorder | null = null;
  private voiceEnabled: boolean = true;
  private animCb: ((name: string) => void) | null = null;
  // v0.19.0 — state machine + UX prefs.
  private state: BubbleState = 'standard';
  private tint: BubbleTint = 'default';
  private defaultState: DefaultBubbleState = 'standard';
  private pinned: boolean = false;
  // Cached bubble bounds + avoidance state. Recomputed on each state change;
  // not per-tick — getBoundingClientRect is cheap but doing it inside the
  // cursor pump (~60Hz) is still wasted work.
  private bubbleRect: DOMRect | null = null;
  private avoiding: '' | 'left' | 'right' | 'up' | 'down' = '';

  constructor(onSend: (text: string) => void) {
    this.bubble = document.getElementById('bubble')!;
    this.bubbleText = document.getElementById('bubble-text')!;
    this.actionsArea = document.getElementById('bubble-actions')!;
    this.history = document.getElementById('bubble-history')!;
    this.chips = document.getElementById('bubble-chips')!;
    this.inputArea = document.getElementById('bubble-input-area')!;
    this.input = document.getElementById('bubble-input') as HTMLInputElement;
    this.sendBtn = document.getElementById('bubble-send') as HTMLButtonElement;
    this.micBtn = document.getElementById('bubble-mic') as HTMLButtonElement | null;
    this.micLevel = this.micBtn ? this.micBtn.querySelector('.mic-level') : null;
    this.attachBtn = document.getElementById('bubble-attach') as HTMLButtonElement | null;
    this.expandHandle = document.getElementById('bubble-expand-handle') as HTMLButtonElement | null;
    this.header = document.getElementById('bubble-header')!;
    this.minimizeBtn = document.getElementById('bubble-minimize') as HTMLButtonElement | null;
    this.pinBtn = document.getElementById('bubble-pin') as HTMLButtonElement | null;
    this.closeBtn = document.getElementById('bubble-close') as HTMLButtonElement | null;
    this.onSend = onSend;

    // Initial state — keep the standard-state default so legacy callers
    // (e.g. update prompts) keep getting the multi-line layout.
    this.setState('standard');
    this.setTint('default', { hint: false });

    // ── Mic button (unchanged from v0.17.2) ────────────────────────
    if (this.micBtn) {
      this.micBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (this.isRecording()) {
          void this.stopVoice();
        } else if (this.recorder?.getState() === 'encoding') {
          return;
        } else {
          void this.startVoice();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isRecording()) {
          e.preventDefault();
          this.cancelVoice();
        }
      });
    }

    // ── Compact click → standard. Standard text-click → history. ───
    // We split the click handler by state so behavior stays predictable
    // even after a tint-driven re-render.
    this.bubble.addEventListener('click', (e) => {
      if (this.state === 'compact') {
        e.stopPropagation();
        this.setState('standard');
      }
    });
    this.bubbleText.addEventListener('click', (e) => {
      if (this.state === 'compact') return; // handled by bubble-level click
      e.stopPropagation();
      if (this.state === 'expanded') return; // history is always visible
      if (this.showingHistory) this.toggleInput();
      else this.showChatHistory();
    });

    this.sendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
      e.stopPropagation();
    });

    // ── Standard → expanded via corner handle ───────────────────────
    if (this.expandHandle) {
      this.expandHandle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setState('expanded');
      });
    }
    // ── Expanded header controls ────────────────────────────────────
    if (this.minimizeBtn) {
      this.minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setState('compact');
      });
    }
    if (this.pinBtn) {
      this.pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pinned = !this.pinned;
        this.pinBtn!.setAttribute('aria-pressed', String(this.pinned));
      });
    }
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hide();
      });
    }
    // ESC at top level closes the expanded panel.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.state === 'expanded' && !this.isRecording()) {
        e.preventDefault();
        this.setState('standard');
      }
    });

    // Right-click bubble → context menu (unchanged)
    this.bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.clippy.showContextMenu();
    });

    // ── Smart positioning / avoidance ──────────────────────────────
    // The preload bridge already pumps cursor positions for cursor-look;
    // we hook the same stream rather than asking main for a new channel.
    window.clippy.onCursorPos?.((pos) => this.onCursorTick(pos));
  }

  // ───────────────────────────────────────────────────────────────────
  // v0.19.0 — public state + tint API
  // ───────────────────────────────────────────────────────────────────

  /**
   * Switch to a new visual state. Manages keyboard focus when entering
   * the input area (expanded), and clears the auto-hide timer for
   * expanded since the user has explicitly opened it.
   */
  setState(state: BubbleState): void {
    this.state = state;
    this.bubble.setAttribute('data-state', state);

    // Visibility of conditional regions is mostly driven by CSS via
    // [data-state], but the input area uses an .hidden class that
    // predates this PR. Reconcile.
    if (state === 'expanded') {
      this.inputArea.classList.remove('hidden');
      this.input.focus();
      this.clearAutoHide();
      // Snap to the side of the screen Clippy is on. We don't know
      // Clippy's display server-side from here, but we DO know our own
      // bounds via getBoundingClientRect; pin to bottom-right by default
      // (where Clippy lives) and let main-process window placement do
      // the multi-monitor work.
      this.bubble.style.right  = '5px';
      this.bubble.style.bottom = '5px';
    } else if (state === 'compact') {
      // Compact has no input. Hide the input area but keep the value
      // so re-expansion preserves a half-typed message.
      this.inputArea.classList.add('hidden');
    } else { // 'standard'
      // Restore the default fixed position for the tip layout.
      this.bubble.style.right  = '5px';
      this.bubble.style.bottom = '100px';
    }

    // Recompute cached rect for avoidance calculations.
    requestAnimationFrame(() => { this.bubbleRect = this.bubble.getBoundingClientRect(); });
  }

  /**
   * Switch the contextual tint. Plays the one-shot hint animation
   * (glow / blink / pulse / shimmer / shake / check) unless suppressed
   * via `opts.hint = false` — useful during the constructor where we
   * set an initial tint without the visual cue.
   */
  setTint(tint: BubbleTint, opts: { hint?: boolean } = {}): void {
    this.tint = tint;
    this.bubble.setAttribute('data-tint', tint);
    if (opts.hint === false) return;
    // Re-add the hint class so the keyframes restart even if the user
    // re-triggered the same tint. forced reflow via void offsetWidth is
    // the standard CSS-restart trick.
    this.bubble.classList.remove('bubble--tint-hint');
    void this.bubble.offsetWidth;
    this.bubble.classList.add('bubble--tint-hint');
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
    // Strip the class after the longest hint animation finishes (1.6s
    // info-blink). Past that, idle visuals take over.
    this.hintTimer = window.setTimeout(() => {
      this.bubble.classList.remove('bubble--tint-hint');
      this.hintTimer = null;
    }, 1800);
  }

  /**
   * Populate suggestion chips. No-op unless the bubble is expanded —
   * chips are an expanded-only affordance. The render contract here
   * matches what PR-3's contextual-suggestion engine will emit; for
   * now any caller can pass static chips.
   */
  setSuggestionChips(suggestions: SuggestionChip[]): void {
    this.chips.innerHTML = '';
    if (!suggestions || suggestions.length === 0) {
      this.chips.classList.add('hidden');
      return;
    }
    if (this.state !== 'expanded') return; // contract: silent no-op
    this.chips.classList.remove('hidden');
    suggestions.forEach((chip, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bubble-chip';
      btn.textContent = chip.label;
      btn.style.setProperty('--i', String(i)); // drives stagger-fade
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Existing IPC: chips fan through onSend, matching how typed
        // messages go upstream. main.ts then calls the brain.
        this.onSend(chip.action);
      });
      this.chips.appendChild(btn);
    });
  }

  /**
   * Minimal markdown renderer — bold, inline code, code fences, bullet
   * lists. Intentionally small (~40 lines) so we don't pull `marked`
   * for what's mostly a tip-rendering feature. The output is safe HTML
   * because every non-markdown character is escaped first; markdown
   * tokens are then re-injected as element tags.
   */
  renderMarkdown(text: string): string {
    if (!text) return '';
    // 1. extract code fences first so their contents aren't touched.
    const fences: string[] = [];
    let escaped = text.replace(/```([\s\S]*?)```/g, (_m, body) => {
      const idx = fences.length;
      fences.push(String(body).replace(/^\n/, ''));
      return ` FENCE${idx} `;
    });
    // 2. escape the rest.
    escaped = escaped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 3. inline code (single backticks).
    escaped = escaped.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);
    // 4. bold (**x**).
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
    // 5. bullet lists (lines starting with "- " or "* ").
    const lines = escaped.split('\n');
    const out: string[] = [];
    let inList = false;
    for (const ln of lines) {
      const m = ln.match(/^[ \t]*[-*][ \t]+(.*)$/);
      if (m) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${m[1]}</li>`);
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(ln);
      }
    }
    if (inList) out.push('</ul>');
    let html = out.join('\n').replace(/\n/g, '<br>');
    // 6. re-inject fenced code as <pre><code>.
    html = html.replace(/ FENCE(\d+) /g, (_m, i) => {
      const body = fences[Number(i)] || '';
      const esc = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code>${esc}</code></pre>`;
    });
    return html;
  }

  /**
   * v0.17.7 — render text + a row of inline action buttons. Used for
   * update prompts, confirmation flows, anything that wants explicit
   * clickable choices instead of a hidden "click Clippy" semantics.
   *
   * Backward-compat note: pre-PR-2 there was no `speakWithActions`
   * implementation, only a placeholder in index.html. Callers either
   * built their own buttons or relied on click-Clippy semantics. Now
   * they have a real entry point with the warning tint baked in.
   */
  speakWithActions(text: string, actions: BubbleActionButton[]): void {
    this.speak(text, { autoState: 'standard', tint: 'warning' });
    this.actionsArea.innerHTML = '';
    this.actionsArea.classList.remove('hidden');
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = a.label;
      if (a.variant === 'primary') btn.style.background = 'var(--tint-accent)';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (a.onClick) {
          try { a.onClick(); } catch { /* caller logs */ }
        } else {
          this.onSend(a.label);
        }
      });
      this.actionsArea.appendChild(btn);
    }
  }

  /** Backward-compat alias. Some callers used `showError` historically;
   *  it's now sugar over speakError. */
  showError(text: string, onRetry?: () => void): void {
    this.speakError(text, onRetry);
  }

  /** v0.19.0 — defaults the bubble's resting state. Compact-by-default
   *  is opt-in via Settings; standard remains the safe default for any
   *  caller that doesn't care. */
  setDefaultState(state: DefaultBubbleState): void {
    this.defaultState = state;
  }

  /** v0.19.0 — pin toggle persisted via settings. When pinned, the
   *  bubble stays in its current expanded/standard state across
   *  successive speak() calls (auto-hide is also suppressed). */
  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    if (this.pinBtn) this.pinBtn.setAttribute('aria-pressed', String(pinned));
  }

  // ───────────────────────────────────────────────────────────────────
  // Existing public API — kept backward compatible
  // ───────────────────────────────────────────────────────────────────

  speak(text: string, opts: { autoState?: BubbleState; tint?: BubbleTint } = {}): void {
    this.chatHistory.push({ role: 'clippy', text, time: new Date() });
    this.showingHistory = false;
    // Pick a sane state if the caller didn't ask for one. Short tips →
    // compact (when the user has opted into it as the default); long
    // replies or anything with markdown → standard.
    const targetState: BubbleState = opts.autoState ?? this.chooseStateFor(text);
    if (!this.pinned || this.state === 'compact') this.setState(targetState);
    // Tint defaults to neutral "default" for proactive tips. Callers
    // can override via opts.tint.
    if (opts.tint) this.setTint(opts.tint);
    else this.setTint('default', { hint: this.state !== 'expanded' });

    this.show();
    this.actionsArea.classList.add('hidden');
    this.actionsArea.innerHTML = '';

    if (this.state === 'expanded') {
      // Expanded panel uses the history view for replies. Re-render
      // history including this new message.
      this.renderHistoryPanel();
    } else {
      this.bubbleText.textContent = '';
      this.bubbleText.className = '';
      this.clearTypeTimer();
      const interval = text.length > 80 ? TYPE_INTERVAL_FAST_MS : TYPE_INTERVAL_NORMAL_MS;
      let i = 0;
      this.typeTimer = window.setInterval(() => {
        this.bubbleText.textContent += text[i];
        i++;
        if (i >= text.length) this.clearTypeTimer();
      }, interval);
    }
    this.resetAutoHide();
  }

  /**
   * v0.12.5 — visually distinct error reply with optional retry. Now
   * also flips the bubble's data-tint to "error", which both colors
   * the wash and plays the shake animation once.
   */
  speakError(text: string, onRetry?: () => void): void {
    this.chatHistory.push({ role: 'clippy', text, time: new Date() });
    this.showingHistory = false;
    // Errors stay in whatever state we were in (don't escalate compact
    // → standard mid-error), but force the legacy class so older CSS
    // selectors keep matching.
    if (this.state === 'compact') this.setState('standard');
    this.setTint('error');
    this.show();
    this.actionsArea.classList.add('hidden');

    if (this.state === 'expanded') {
      this.renderHistoryPanel();
    } else {
      this.bubbleText.textContent = text;
      this.bubbleText.className = 'bubble-error';
      this.clearTypeTimer();

      if (onRetry) {
        const btn = document.createElement('button');
        btn.className = 'bubble-retry-btn';
        btn.textContent = 'Try again';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          btn.disabled = true;
          btn.textContent = 'Retrying…';
          try { onRetry(); } catch { /* swallow */ }
        });
        this.bubbleText.appendChild(document.createElement('br'));
        this.bubbleText.appendChild(btn);
      }
    }
    this.resetAutoHide();
  }

  setAutoHideMs(ms: number): void {
    this.autoHideMs = Math.max(0, ms | 0);
    if (this.hideTimer !== null) this.resetAutoHide();
  }

  showThinking(): void {
    this.showingHistory = false;
    if (this.state === 'compact') this.setState('standard');
    this.setTint('busy');
    this.show();
    this.bubbleText.textContent = '…';
    this.bubbleText.className = '';
    this.clearAutoHide();
  }

  hide(): void {
    this.bubble.classList.add('hidden');
    this.hideInput();
    this.showingHistory = false;
    this.clearAutoHide();
    this.clearTypeTimer();
    window.clippy.collapseWindow();
  }

  // Public so smoke tests + main.ts can call it directly.
  toggleInput(): void {
    const hidden = this.inputArea.classList.contains('hidden');
    if (hidden) {
      this.inputArea.classList.remove('hidden');
      this.input.focus();
      this.clearAutoHide();
    } else {
      this.hideInput();
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────

  private chooseStateFor(text: string): BubbleState {
    // If user pinned to expanded, stay there.
    if (this.pinned && this.state === 'expanded') return 'expanded';
    if (this.pinned && this.state === 'standard') return 'standard';
    // Short tips honor the user's default-state preference.
    if (this.defaultState === 'compact' && text.length <= COMPACT_TEXT_THRESHOLD) {
      return 'compact';
    }
    return 'standard';
  }

  private show(): void {
    this.bubble.classList.remove('hidden');
    window.clippy.expandWindow();
    // Force a rect refresh after the show transition.
    requestAnimationFrame(() => { this.bubbleRect = this.bubble.getBoundingClientRect(); });
  }

  private showChatHistory(): void {
    this.showingHistory = true;
    this.clearAutoHide();
    this.bubbleText.className = 'chat-history';
    if (this.chatHistory.length === 0) {
      this.bubbleText.innerHTML = '<div class="chat-empty">No messages yet. Click to chat!</div>';
      this.toggleInput();
      return;
    }
    const recent = this.chatHistory.slice(-8);
    this.bubbleText.innerHTML = recent.map((msg) => {
      const timeStr = msg.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const body = this.escapeHtml(msg.text);
      if (msg.role === 'user') {
        return `<div class="chat-msg chat-user"><span class="chat-label">You</span> ${body}<span class="chat-time">${timeStr}</span></div>`;
      }
      return `<div class="chat-msg chat-clippy"><span class="chat-label">\u{1F4CE}</span> ${body}<span class="chat-time">${timeStr}</span></div>`;
    }).join('');
    this.bubbleText.scrollTop = this.bubbleText.scrollHeight;
    this.inputArea.classList.remove('hidden');
    this.input.focus();
  }

  /** Expanded-state history panel. Markdown-rendered for Clippy turns;
   *  user turns are rendered as plain text (no HTML injection risk). */
  private renderHistoryPanel(): void {
    if (this.chatHistory.length === 0) {
      this.history.innerHTML = '<div class="chat-empty">No messages yet. Say hello!</div>';
      return;
    }
    const recent = this.chatHistory.slice(-32);
    this.history.innerHTML = recent.map((msg) => {
      const timeStr = msg.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (msg.role === 'user') {
        return `<div class="chat-msg chat-user"><span class="chat-label">You</span> ${this.escapeHtml(msg.text)}<span class="chat-time">${timeStr}</span></div>`;
      }
      // Clippy turns get full markdown rendering.
      return `<div class="chat-msg chat-clippy"><span class="chat-label">\u{1F4CE}</span> ${this.renderMarkdown(msg.text)}<span class="chat-time">${timeStr}</span></div>`;
    }).join('');
    this.history.scrollTop = this.history.scrollHeight;
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private hideInput(): void {
    this.inputArea.classList.add('hidden');
    this.input.value = '';
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text) return;
    this.chatHistory.push({ role: 'user', text, time: new Date() });
    this.input.value = '';
    if (this.state !== 'expanded') this.hideInput();
    this.showThinking();
    this.onSend(text);
  }

  private resetAutoHide(): void {
    this.clearAutoHide();
    if (this.pinned) return; // pinned = never auto-hide
    if (this.state === 'expanded') return; // explicit user open
    if (this.autoHideMs <= 0) return;
    this.hideTimer = window.setTimeout(() => {
      if (!this.showingHistory) this.hide();
    }, this.autoHideMs);
  }

  private clearAutoHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private clearTypeTimer(): void {
    if (this.typeTimer !== null) {
      clearInterval(this.typeTimer);
      this.typeTimer = null;
    }
  }

  // ── Smart-avoidance cursor pump ──────────────────────────────────
  private onCursorTick(pos: { cx: number; cy: number; mx: number; my: number }): void {
    // Skip if the bubble is hidden — no point thrashing transforms.
    if (this.bubble.classList.contains('hidden')) return;
    if (!this.bubbleRect) this.bubbleRect = this.bubble.getBoundingClientRect();
    const r = this.bubbleRect;
    if (!r) return;
    // Translate global mouse coords (mx/my) into client-space relative
    // to the window. We don't have window origin from here — preload
    // already publishes both global (mx) and clippy-relative (cx) coords;
    // cx is what we want for hit-testing against client geometry.
    const px = pos.cx;
    const py = pos.cy;
    // Closest distance from cursor to the bubble's edge (0 if inside).
    const dx = Math.max(r.left - px, 0, px - r.right);
    const dy = Math.max(r.top - py, 0, py - r.bottom);
    const dist = Math.hypot(dx, dy);

    const releaseThresh = this.avoiding ? AVOIDANCE_RELEASE_PX : AVOIDANCE_RADIUS_PX;
    if (dist < AVOIDANCE_RADIUS_PX && !this.avoiding) {
      // Direction from bubble center to cursor — slide opposite.
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const vx = px - cx;
      const vy = py - cy;
      // Pick dominant axis. Horizontal usually wins because the bubble
      // sits in a vertical strip on the right; left-slide is the most
      // common avoidance direction.
      if (Math.abs(vx) >= Math.abs(vy)) {
        this.avoiding = vx > 0 ? 'left' : 'right';
      } else {
        this.avoiding = vy > 0 ? 'up' : 'down';
      }
      this.bubble.setAttribute('data-avoid', this.avoiding);
    } else if (dist > releaseThresh && this.avoiding) {
      this.avoiding = '';
      this.bubble.removeAttribute('data-avoid');
    }
  }

  // ── v0.17.0 — Voice input (unchanged from previous patch) ───────

  isRecording(): boolean {
    return this.recorder?.getState() === 'recording' || this.recorder?.getState() === 'requesting';
  }

  setVoiceEnabled(enabled: boolean): void {
    this.voiceEnabled = enabled;
    if (this.micBtn) this.micBtn.style.display = enabled ? '' : 'none';
    if (!enabled && this.recorder) this.recorder.cancel();
  }

  setAnimCallback(cb: (name: string) => void): void {
    this.animCb = cb;
  }

  private requestAnim(name: string): void {
    if (this.animCb) this.animCb(name);
  }

  async startVoice(): Promise<void> {
    if (!this.voiceEnabled) return;
    if (this.isRecording()) return;
    this.show();
    if (this.state === 'compact') this.setState('standard');
    if (this.inputArea.classList.contains('hidden')) this.toggleInput();

    if (!this.recorder) {
      this.recorder = new Recorder({
        onLevel: (level) => {
          if (this.micLevel) {
            this.micLevel.style.setProperty('--lvl', String(0.4 + level * 1.4));
          }
        },
        onStateChange: (s) => {
          if (this.micBtn) {
            this.micBtn.classList.toggle('recording', s === 'recording');
            this.micBtn.classList.toggle('encoding', s === 'encoding');
          }
          if (s === 'recording') this.requestAnim('Hearing_1');
          else if (s === 'idle') this.requestAnim('Idle1_1');
        },
        onResult: (wav, durationMs) => {
          this.input.placeholder = 'Transcribing...';
          this.input.disabled = true;
          void window.clippy.transcribeAudio?.(wav)
            .then((res) => {
              this.input.disabled = false;
              this.input.placeholder = 'Type to Clippy...';
              if (!res || !res.ok) {
                this.speakError(`Voice failed: ${(res && res.error) || 'unknown error'}`);
                return;
              }
              const text = (res.text || '').trim();
              if (!text) {
                this.speakError("I didn't catch that.");
                return;
              }
              this.input.value = text;
              this.input.focus();
              if (durationMs >= 600 && text.length >= 4 && /\s/.test(text)) {
                setTimeout(() => this.submit(), 350);
              }
            })
            .catch((err) => {
              this.input.disabled = false;
              this.input.placeholder = 'Type to Clippy...';
              this.speakError(`Voice failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        },
        onError: (msg) => {
          this.speakError(msg);
        },
      });
    }

    try {
      await this.recorder.start();
    } catch {
      // Recorder already emitted onError
    }
  }

  async stopVoice(): Promise<void> {
    if (!this.recorder) return;
    if (this.recorder.getState() === 'recording') {
      await this.recorder.stop();
    }
  }

  cancelVoice(): void {
    if (!this.recorder) return;
    this.recorder.cancel();
    this.input.placeholder = 'Type to Clippy...';
    this.input.disabled = false;
    if (this.micBtn) {
      this.micBtn.classList.remove('recording', 'encoding');
    }
    this.requestAnim('Idle1_1');
  }
}
