/**
 * Minimal Chrome DevTools Protocol client for Clippy.
 *
 * Connects to a browser launched with --remote-debugging-port=9223 (or a
 * different port) and exposes the high-level operations Clippy needs:
 *
 *   - Page text extraction
 *   - Click by selector or visible text
 *   - Type into a field by selector or label
 *   - Select dropdown option
 *   - Evaluate arbitrary JavaScript
 *   - Wait for selector
 *   - List + switch tabs
 *   - Scroll
 *
 * Why not Playwright? Playwright is ~3MB of npm + a postinstall step that
 * tries to download a Chromium binary. We connect to a user-launched browser
 * over WebSocket — we don't need any of that. This file uses only `http`
 * (built-in) and `ws` (~190KB, no native bindings).
 *
 * Design cherry-picked from clawdcursor's cdp-driver.ts but reimplemented
 * in ~300 lines vs. their 1095, dropping the cursor-overlay injection,
 * Playwright dependency, and multi-context tab-switching.
 *
 * The browser must be launched with --remote-debugging-port=<port>. Clippy's
 * `cdp_connect` tool returns a clear error with relaunch instructions if it
 * can't find a CDP endpoint.
 */

import http from 'http';
import WebSocket from 'ws';

export const DEFAULT_CDP_PORT = 9223;

interface DevToolsTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

export interface CdpResult {
  success: boolean;
  method?: string;
  error?: string;
  value?: unknown;
}

class CDPClient {
  private port: number;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private currentTargetId: string | null = null;
  private currentUrl = '';
  private currentTitle = '';

  constructor(port = DEFAULT_CDP_PORT) {
    this.port = port;
  }

  // ── Connection ───────────────────────────────────────────────

  /** Returns true if connection succeeded. */
  async connect(port?: number): Promise<{ ok: boolean; url?: string; title?: string; error?: string }> {
    if (port) this.port = port;
    try { await this.disconnect(); } catch { /* ignore */ }
    const targets = await this.listTargets();
    if (targets.length === 0) {
      return { ok: false, error: `No browser tabs found. Launch Edge/Chrome with --remote-debugging-port=${this.port}.` };
    }
    // Prefer a real http(s) page over edge://newtab, etc.
    const preferred = targets.find((t) => t.url.startsWith('http')) ?? targets[0];
    return this.attachToTarget(preferred);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.currentTargetId = null;
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** GET /json — list page targets via the CDP HTTP discovery endpoint. */
  async listTargets(): Promise<DevToolsTarget[]> {
    const json = await this.httpGetJson('/json');
    if (!Array.isArray(json)) return [];
    return (json as DevToolsTarget[]).filter((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  }

  /** Switch to a tab whose URL OR title contains the substring. */
  async switchTab(substring: string): Promise<{ ok: boolean; url?: string; title?: string; error?: string }> {
    const lower = substring.toLowerCase();
    const targets = await this.listTargets();
    const match = targets.find(
      (t) => t.url.toLowerCase().includes(lower) || (t.title || '').toLowerCase().includes(lower),
    );
    if (!match) return { ok: false, error: `No tab matching "${substring}"` };
    return this.attachToTarget(match);
  }

  // ── Commands ─────────────────────────────────────────────────

  async evaluate<T = unknown>(expression: string, returnByValue = true): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
    })) as { result: { value?: T; description?: string }; exceptionDetails?: unknown };
    if (r.exceptionDetails) {
      throw new Error(`JS exception: ${(r.exceptionDetails as { text?: string }).text || 'unknown'}`);
    }
    return r.result.value as T;
  }

  /** Read text content from a CSS selector. */
  async readText(selector = 'body', maxLength = 3000): Promise<string> {
    const expr = `(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const t=(el.innerText||el.textContent||'').trim();return t.length>${maxLength}?t.slice(0,${maxLength})+'...':t;})()`;
    const result = await this.evaluate<string | null>(expr);
    if (result === null) throw new Error(`No element matches "${selector}"`);
    return result;
  }

  /** Get a structured summary of interactive elements on the page. */
  async getPageContext(maxElements = 50): Promise<string> {
    const expr = `(function(){
      const interactive = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'));
      const out = [];
      for (let i = 0; i < interactive.length && out.length < ${maxElements}; i++) {
        const el = interactive[i];
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || '').trim().slice(0, 60);
        const id = el.id ? '#' + el.id : '';
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/).slice(0, 2).join('.') : '';
        const sel = id || (cls && tag + cls.slice(0, 50)) || tag + ':nth-of-type(' + (i + 1) + ')';
        out.push(tag + (role ? '[role=' + role + ']' : '') + ': "' + name + '" sel=' + sel);
      }
      return out.join('\\n');
    })()`;
    return await this.evaluate<string>(expr);
  }

  /** Click by CSS selector. */
  async click(selector: string): Promise<CdpResult> {
    const expr = `(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'not_found';el.scrollIntoView({block:'center'});el.click();return 'ok';})()`;
    try {
      const r = await this.evaluate<string>(expr);
      if (r === 'not_found') return { success: false, error: `No element matches "${selector}"` };
      return { success: true, method: 'selector' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Click by visible text content (matches innerText). */
  async clickByText(text: string): Promise<CdpResult> {
    const expr = `(function(){
      const target=${JSON.stringify(text)}.toLowerCase();
      const candidates=Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="submit"],input[type="button"]'));
      for(const el of candidates){
        const t=(el.innerText||el.value||el.getAttribute('aria-label')||'').trim().toLowerCase();
        if(t===target||t.includes(target)){
          const rect=el.getBoundingClientRect();
          if(rect.width===0||rect.height===0)continue;
          el.scrollIntoView({block:'center'});
          el.click();
          return 'ok';
        }
      }
      return 'not_found';
    })()`;
    try {
      const r = await this.evaluate<string>(expr);
      if (r === 'not_found') return { success: false, error: `No clickable element with text "${text}"` };
      return { success: true, method: 'text' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Type into an input field by selector. */
  async typeInField(selector: string, text: string): Promise<CdpResult> {
    const expr = `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el)return 'not_found';
      el.scrollIntoView({block:'center'});el.focus();
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')&&Object.getOwnPropertyDescriptor(proto,'value').set;
      if(setter){setter.call(el,${JSON.stringify(text)});}else{el.value=${JSON.stringify(text)};}
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return 'ok';
    })()`;
    try {
      const r = await this.evaluate<string>(expr);
      if (r === 'not_found') return { success: false, error: `No input matches "${selector}"` };
      return { success: true, method: 'selector' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Type into the input associated with a <label> matching the given text. */
  async typeByLabel(labelText: string, text: string): Promise<CdpResult> {
    const expr = `(function(){
      const target=${JSON.stringify(labelText)}.toLowerCase();
      const labels=Array.from(document.querySelectorAll('label'));
      for(const lbl of labels){
        if((lbl.innerText||'').trim().toLowerCase().includes(target)){
          const id=lbl.getAttribute('for');
          let input=id?document.getElementById(id):lbl.querySelector('input,textarea,select');
          if(!input)continue;
          input.scrollIntoView({block:'center'});input.focus();
          const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
          const setter=Object.getOwnPropertyDescriptor(proto,'value')&&Object.getOwnPropertyDescriptor(proto,'value').set;
          if(setter){setter.call(input,${JSON.stringify(text)});}else{input.value=${JSON.stringify(text)};}
          input.dispatchEvent(new Event('input',{bubbles:true}));
          input.dispatchEvent(new Event('change',{bubbles:true}));
          return 'ok';
        }
      }
      // Fallback: aria-labelledby / aria-label
      const aria=Array.from(document.querySelectorAll('input,textarea,select')).find(el=>(el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').toLowerCase().includes(target));
      if(aria){
        aria.scrollIntoView({block:'center'});aria.focus();
        const proto=aria.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(proto,'value')&&Object.getOwnPropertyDescriptor(proto,'value').set;
        if(setter){setter.call(aria,${JSON.stringify(text)});}else{aria.value=${JSON.stringify(text)};}
        aria.dispatchEvent(new Event('input',{bubbles:true}));
        aria.dispatchEvent(new Event('change',{bubbles:true}));
        return 'ok';
      }
      return 'not_found';
    })()`;
    try {
      const r = await this.evaluate<string>(expr);
      if (r === 'not_found') return { success: false, error: `No input labeled "${labelText}"` };
      return { success: true, method: 'label' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Select an option in a <select> by value or visible text. */
  async selectOption(selector: string, valueOrText: string): Promise<CdpResult> {
    const expr = `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el||el.tagName!=='SELECT')return 'not_found';
      const target=${JSON.stringify(valueOrText)};
      const opt=Array.from(el.options).find(o=>o.value===target||o.text===target||o.text.includes(target));
      if(!opt)return 'no_option';
      el.value=opt.value;
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return 'ok';
    })()`;
    try {
      const r = await this.evaluate<string>(expr);
      if (r === 'not_found') return { success: false, error: `No <select> matches "${selector}"` };
      if (r === 'no_option') return { success: false, error: `No option with value/text "${valueOrText}"` };
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Wait for a selector to be present and visible. */
  async waitForSelector(selector: string, timeoutMs = 10_000): Promise<CdpResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const expr = `(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;})()`;
      try {
        const found = await this.evaluate<boolean>(expr);
        if (found) return { success: true };
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { success: false, error: `Timed out waiting for "${selector}"` };
  }

  async getUrl(): Promise<string> {
    return this.currentUrl;
  }

  async getTitle(): Promise<string> {
    return this.currentTitle;
  }

  // ── Internals ────────────────────────────────────────────────

  private async attachToTarget(target: DevToolsTarget): Promise<{ ok: boolean; url?: string; title?: string; error?: string }> {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        const timeout = setTimeout(() => {
          try { ws.close(); } catch { /* ignore */ }
          resolve({ ok: false, error: 'CDP WebSocket connection timed out' });
        }, 8000);
        ws.on('open', () => {
          clearTimeout(timeout);
          this.ws = ws;
          this.currentTargetId = target.id;
          this.currentUrl = target.url;
          this.currentTitle = target.title;
          // Enable Page + Runtime domains; not all CDP commands need this but many do.
          this.send('Page.enable').catch(() => {});
          this.send('Runtime.enable').catch(() => {});
          resolve({ ok: true, url: target.url, title: target.title });
        });
        ws.on('message', (data) => this.onMessage(String(data)));
        ws.on('error', (err) => {
          clearTimeout(timeout);
          resolve({ ok: false, error: `WS error: ${err.message}` });
        });
        ws.on('close', () => {
          this.ws = null;
          this.currentTargetId = null;
          // Reject every pending command — without this, callers await
          // forever and the agent loop wedges. (Sonnet code review caught
          // this: "If the browser is killed while a CDP call is in flight,
          // those promises hang forever and the brain loop sits at await
          // client.evaluate(...) until the 60s callTurn timeout.")
          for (const [, p] of this.pending) p.reject(new Error('CDP connection closed'));
          this.pending.clear();
        });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('CDP not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      // Hard timeout per command — prevents hung tools
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout for ${method}`));
        }
      }, 15_000);
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  private httpGetJson(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path, timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error(`CDP /json timeout — is the browser launched with --remote-debugging-port=${this.port}?`)); });
    });
  }
}

// ── Singleton ──────────────────────────────────────────────────

let singleton: CDPClient | null = null;
export function getCdpClient(): CDPClient {
  if (!singleton) singleton = new CDPClient();
  return singleton;
}

/** List tabs on a port WITHOUT requiring a connection — used by cdp_list_tabs. */
export async function listTabsRaw(port = DEFAULT_CDP_PORT): Promise<DevToolsTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += String(chunk)));
      res.on('end', () => {
        try {
          const arr = JSON.parse(body) as DevToolsTarget[];
          resolve(arr.filter((t) => t.type === 'page'));
        } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`CDP not running on port ${port}`)));
  });
}
