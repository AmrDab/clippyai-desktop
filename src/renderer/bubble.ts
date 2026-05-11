// v0.12.3 — auto-hide is now configurable via Settings.bubbleAutoHideMs.
// 0 = "Manual" (never auto-hide). Default 30000 (was 20000 — 20s stole long
// replies mid-read per UX audit finding #4).
const DEFAULT_AUTO_HIDE_MS = 30000;
// v0.12.3 — typewriter speeds up when text is long so TTS doesn't finish
// 5s before the bubble. 25ms/char on a 200-char tip = 5s typing while TTS
// finishes in ~3s. Per UX audit finding #1.
const TYPE_INTERVAL_FAST_MS = 10;  // for replies > 80 chars
const TYPE_INTERVAL_NORMAL_MS = 18; // for short replies (still feels alive)

interface ChatMessage {
  role: 'user' | 'clippy' | 'system';
  text: string;
  time: Date;
}

export class BubbleController {
  private bubble: HTMLElement;
  private bubbleText: HTMLElement;
  private inputArea: HTMLElement;
  private input: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private onSend: (text: string) => void;
  private typeTimer: number | null = null;
  private hideTimer: number | null = null;
  private chatHistory: ChatMessage[] = [];
  private showingHistory: boolean = false;
  // v0.12.3 — runtime-configurable auto-hide. Set via setAutoHideMs() from
  // settings IPC. 0 = manual / never auto-hide.
  private autoHideMs: number = DEFAULT_AUTO_HIDE_MS;

  constructor(onSend: (text: string) => void) {
    this.bubble = document.getElementById('bubble')!;
    this.bubbleText = document.getElementById('bubble-text')!;
    this.inputArea = document.getElementById('bubble-input-area')!;
    this.input = document.getElementById('bubble-input') as HTMLInputElement;
    this.sendBtn = document.getElementById('bubble-send') as HTMLButtonElement;
    this.onSend = onSend;

    // Click bubble text → toggle between history and input
    this.bubbleText.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.showingHistory) {
        this.toggleInput();
      } else {
        this.showChatHistory();
      }
    });

    this.sendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.submit();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
      e.stopPropagation();
    });

    // Right-click bubble → show context menu
    this.bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.clippy.showContextMenu();
    });
  }

  speak(text: string): void {
    this.chatHistory.push({ role: 'clippy', text, time: new Date() });
    this.showingHistory = false;
    this.show();
    this.bubbleText.textContent = '';
    this.bubbleText.className = '';
    this.clearTypeTimer();

    // v0.12.3 — adaptive typewriter speed. Long replies (>80 chars) type
    // ~2.5x faster so the bubble finishes around the same time TTS does
    // (TTS speaks at ~150 wpm ≈ 12 chars/s; old 25ms/char = 40 chars/s
    // started fast then fell behind the spoken voice).
    const interval = text.length > 80 ? TYPE_INTERVAL_FAST_MS : TYPE_INTERVAL_NORMAL_MS;
    let i = 0;
    this.typeTimer = window.setInterval(() => {
      this.bubbleText.textContent += text[i];
      i++;
      if (i >= text.length) this.clearTypeTimer();
    }, interval);

    this.resetAutoHide();
  }

  /**
   * v0.12.5 — visually distinct error reply with optional retry. Per polish
   * audit: error responses ("Hmm, that didn't work — try again!") used to
   * render identically to normal tips, leaving the user to retype manually.
   * The bubble now gets a `.bubble-error` class (red left-border tint) and
   * shows a "Try again" pill if the caller provides a retry handler.
   */
  speakError(text: string, onRetry?: () => void): void {
    this.chatHistory.push({ role: 'clippy', text, time: new Date() });
    this.showingHistory = false;
    this.show();
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
        try { onRetry(); } catch { /* swallow — caller logs */ }
      });
      this.bubbleText.appendChild(document.createElement('br'));
      this.bubbleText.appendChild(btn);
    }
    this.resetAutoHide();
  }

  /**
   * v0.12.3 — runtime override for the auto-hide timeout. Called from
   * settings IPC when the user changes the "Bubble dismiss" setting.
   * 0 = manual (never auto-hide); positive value = ms.
   */
  setAutoHideMs(ms: number): void {
    this.autoHideMs = Math.max(0, ms | 0);
    // If a timer is currently armed, restart it with the new value.
    if (this.hideTimer !== null) this.resetAutoHide();
  }

  showThinking(): void {
    this.showingHistory = false;
    this.show();
    this.bubbleText.textContent = '...';
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

  private show(): void {
    this.bubble.classList.remove('hidden');
    window.clippy.expandWindow();
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

    // Show last 8 messages
    const recent = this.chatHistory.slice(-8);
    this.bubbleText.innerHTML = recent.map((msg) => {
      const timeStr = msg.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (msg.role === 'user') {
        return `<div class="chat-msg chat-user"><span class="chat-label">You</span> ${this.escapeHtml(msg.text)}<span class="chat-time">${timeStr}</span></div>`;
      } else {
        return `<div class="chat-msg chat-clippy"><span class="chat-label">📎</span> ${this.escapeHtml(msg.text)}<span class="chat-time">${timeStr}</span></div>`;
      }
    }).join('');

    // Scroll to bottom
    this.bubbleText.scrollTop = this.bubbleText.scrollHeight;

    // Show input
    this.inputArea.classList.remove('hidden');
    this.input.focus();
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private toggleInput(): void {
    const hidden = this.inputArea.classList.contains('hidden');
    if (hidden) {
      this.inputArea.classList.remove('hidden');
      this.input.focus();
      this.clearAutoHide();
    } else {
      this.hideInput();
    }
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
    this.hideInput();
    this.showThinking();
    this.onSend(text);
  }

  private resetAutoHide(): void {
    this.clearAutoHide();
    // v0.12.3 — autoHideMs===0 means "Manual" (user disabled auto-hide).
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
}
