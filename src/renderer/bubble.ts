const AUTO_HIDE_MS = 20000;

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

    let i = 0;
    this.typeTimer = window.setInterval(() => {
      this.bubbleText.textContent += text[i];
      i++;
      if (i >= text.length) this.clearTypeTimer();
    }, 25);

    this.resetAutoHide();
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
    this.hideTimer = window.setTimeout(() => {
      if (!this.showingHistory) this.hide();
    }, AUTO_HIDE_MS);
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
