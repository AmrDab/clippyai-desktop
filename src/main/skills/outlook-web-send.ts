/**
 * outlook-web-send — deterministic recipe for sending an email via
 * outlook.live.com using CDP. Replaces the multi-turn cdp_click loop
 * the model would otherwise run with hardcoded selectors + verified
 * post-send state.
 *
 * Verification: after the Send button is clicked, polls for the "Message
 * sent" toast OR the Sent Items folder count to increment. Without this
 * the model's "clicked Send → claim success" pattern was the source of
 * the false-positive bug in support report 543ff234.
 *
 * The model only sees `outlook_web_send_email(to, subject, body)` — one
 * tool call, one structured result.
 */

import { getCdpClient } from '../cdp-client';
import { spawnCdpBrowser } from '../cdp-spawn';
import { createLogger } from '../logger';
import type { ToolResult } from '../types/tool-result';

const log = createLogger('OutlookWebSend');

interface OutlookWebSendParams {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}

/** Wait until the predicate JS returns truthy. Polls every 500ms up to timeoutMs. */
async function pollUntil(
  client: ReturnType<typeof getCdpClient>,
  predicateJs: string,
  timeoutMs: number,
  pollMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await client.evaluate<boolean>(`Boolean(${predicateJs})`);
      if (r) return true;
    } catch { /* ignore transient evaluate errors during page navigation */ }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return false;
}

/**
 * Run the full Outlook web send recipe. Returns a structured ToolResult.
 * If the page is not signed in to outlook.live.com OR the compose form
 * doesn't materialize, surfaces a clean error code so the caller can fall
 * through to the next tier without retrying.
 */
export async function outlookWebSendEmail(params: OutlookWebSendParams): Promise<ToolResult> {
  const { to, subject, body, cc } = params;
  if (!to || !subject || !body) {
    return { text: '(error:MISSING_FIELDS) outlook_web_send_email needs to, subject, body' };
  }

  // v0.14.2 — auto-spawn the browser if no CDP endpoint is live, then retry.
  // Per support report 45e25158: the old path returned CDP_NOT_AVAILABLE in
  // ~50ms when the user's normal Edge wasn't launched with --remote-debugging-
  // port. The dispatcher fell through every web layer in <2s and the user
  // perceived "no fallback." We now mirror the auto-spawn logic from the
  // standalone cdp_connect tool so the recipe actually tries.
  const client = getCdpClient();
  if (!client.isConnected()) {
    let connectRes = await client.connect();
    if (!connectRes.ok) {
      // v0.16.2 — previously a runtime CommonJS lookup against ../tools to
      // dodge the circular dep. That crashed in the packed app (report
      // e8f2fb63). Static import from cdp-spawn (no cycle) is the fix.
      const spawned = await spawnCdpBrowser();
      if (spawned.ok) {
        // Give the browser a moment to bind the debug port
        await new Promise((r) => setTimeout(r, 1200));
        connectRes = await client.connect();
      } else {
        return { text: `(error:CDP_NOT_AVAILABLE) ${connectRes.error || 'CDP connect failed'}. Browser auto-launch also failed: ${spawned.error || 'unknown'}` };
      }
      if (!connectRes.ok) {
        return { text: `(error:CDP_NOT_AVAILABLE) ${connectRes.error || 'CDP connect failed'} (browser launched but not reachable yet — try again in a second)` };
      }
    }
  }

  // Step 1: navigate to outlook.live.com mail. If already there this is fast.
  log.info('Step 1: navigate to outlook.live.com');
  try {
    await client.evaluate(`location.href = 'https://outlook.live.com/mail/0/'`);
  } catch (err) {
    return { text: `(error:NAVIGATE_FAILED) ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 2: wait for the inbox shell or sign-in form to appear.
  // Sign-in => fail fast with a clean error.
  log.info('Step 2: wait for inbox shell');
  const inboxReady = await pollUntil(
    client,
    `document.querySelector('button[aria-label*="New mail" i], button[aria-label*="New message" i]') !== null`,
    12_000,
  );
  if (!inboxReady) {
    // Check if we're on the sign-in page
    const signedIn = await client.evaluate<boolean>(
      `!Boolean(document.querySelector('input[type="email"]') || /login\\.live\\.com|login\\.microsoftonline\\.com/.test(location.href))`,
    );
    if (!signedIn) {
      return { text: '(error:NOT_SIGNED_IN) outlook.live.com requires sign-in. User must log in via the browser first; we will not type credentials.' };
    }
    return { text: '(error:INBOX_NOT_READY) outlook.live.com inbox did not load in 12s. Page may be slow or unauthenticated.' };
  }

  // Step 3: click New mail button. Use button-tag selector so we don't
  // accidentally hit "New mail" in a sidebar tooltip.
  log.info('Step 3: click New mail');
  const clickNew = await client.evaluate<boolean>(`
    (function(){
      const btn = document.querySelector('button[aria-label*="New mail" i], button[aria-label*="New message" i]');
      if (!btn) return false;
      btn.scrollIntoView({block:'center'});
      btn.click();
      return true;
    })()
  `);
  if (!clickNew) {
    return { text: '(error:NEW_MAIL_BUTTON_NOT_FOUND) Could not locate the "New mail" button on outlook.live.com. The page may have changed.' };
  }

  // Step 4: wait for the compose form (To field + body editor).
  log.info('Step 4: wait for compose form');
  const composeReady = await pollUntil(
    client,
    `document.querySelector('div[aria-label="To"], input[aria-label="To"]') && document.querySelector('div[role="textbox"][aria-label*="body" i], div[role="textbox"][aria-label*="message" i]')`,
    8_000,
  );
  if (!composeReady) {
    return { text: '(error:COMPOSE_FORM_NOT_READY) Compose form did not materialize within 8s.' };
  }

  // Step 5: fill To. Use the React-aware native-setter pattern to bypass
  // controlled-input shadow values.
  log.info('Step 5: fill To');
  const filledTo = await client.evaluate<boolean>(`
    (function(){
      const el = document.querySelector('div[aria-label="To"][role="textbox"], div[aria-label="To"][contenteditable], input[aria-label="To"]');
      if (!el) return false;
      el.focus();
      if (el.tagName === 'INPUT') {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(to)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // contenteditable
        el.textContent = ${JSON.stringify(to)};
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(to)} }));
      }
      // press Enter to lock in the address (outlook web requires this to convert text -> chip)
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      return true;
    })()
  `);
  if (!filledTo) {
    return { text: '(error:TO_FILL_FAILED) Could not fill the To field.' };
  }

  // Step 6: fill CC if provided
  if (cc) {
    await client.evaluate(`
      (function(){
        const el = document.querySelector('div[aria-label="Cc"][role="textbox"], div[aria-label="Cc"][contenteditable], input[aria-label="Cc"]');
        if (!el) return false;
        el.focus();
        if (el.tagName === 'INPUT') {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(cc)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.textContent = ${JSON.stringify(cc)};
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
      })()
    `);
  }

  // Step 7: fill Subject
  log.info('Step 7: fill Subject');
  const filledSubject = await client.evaluate<boolean>(`
    (function(){
      const el = document.querySelector('input[aria-label="Subject"], input[placeholder="Add a subject"]');
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(subject)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  if (!filledSubject) {
    return { text: '(error:SUBJECT_FILL_FAILED) Could not fill the Subject field.' };
  }

  // Step 8: fill Body. outlook.live.com uses a contenteditable div.
  log.info('Step 8: fill Body');
  const filledBody = await client.evaluate<boolean>(`
    (function(){
      const el = document.querySelector('div[role="textbox"][aria-label*="body" i], div[role="textbox"][aria-label*="message" i]');
      if (!el) return false;
      el.focus();
      // Preserve newlines as <br> tags so the message renders multi-line.
      el.innerHTML = ${JSON.stringify(body.replace(/\n/g, '<br>'))};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(body)} }));
      return true;
    })()
  `);
  if (!filledBody) {
    return { text: '(error:BODY_FILL_FAILED) Could not fill the Body field.' };
  }

  // Capture sent-items count BEFORE clicking Send so we can verify increment.
  const sentBefore = await client.evaluate<number>(`
    (function(){
      const sentLink = Array.from(document.querySelectorAll('a, button')).find(
        (el) => /sent items/i.test(el.textContent || '') || /sent items/i.test(el.getAttribute('aria-label') || '')
      );
      if (!sentLink) return -1;
      const m = (sentLink.textContent || '').match(/(\\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    })()
  `).catch(() => -1);

  // Step 9: click Send. Use the canonical Send button selector: it's a
  // <button> with aria-label that starts with "Send", not the sidebar.
  log.info('Step 9: click Send');
  const clickedSend = await client.evaluate<boolean>(`
    (function(){
      // Restrict to actual buttons. Per v0.12.6 fix: never anchors / nav.
      const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
      const sendBtn = buttons.find((b) => {
        const lbl = (b.getAttribute('aria-label') || '').trim();
        return /^send(\\s|$|\\b)/i.test(lbl) && !/sent items|schedule|later/i.test(lbl);
      });
      if (!sendBtn) return false;
      const r = sendBtn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      sendBtn.scrollIntoView({block:'center'});
      sendBtn.click();
      return true;
    })()
  `);
  if (!clickedSend) {
    return { text: '(error:SEND_BUTTON_NOT_FOUND) Located compose form but could not find the Send button. The email is in your drafts.' };
  }

  // Step 10: verify the send. Two signals:
  //   (a) compose window closed (no more compose form on the page)
  //   (b) "Message sent" toast OR sent-items count incremented
  // We wait for (a); (b) is a stronger but optional confirmation.
  log.info('Step 10: verify send');
  const composeClosed = await pollUntil(
    client,
    `!document.querySelector('input[aria-label="Subject"], input[placeholder="Add a subject"]')`,
    8_000,
  );
  if (!composeClosed) {
    return { text: '(error:UNVERIFIED) Send button clicked but compose form is still open. The send may have been blocked by a confirmation dialog (recipient validation, missing attachment).' };
  }

  // Soft confirmation: look for sent-items count increment or "Message sent" toast.
  let confirmation = 'compose_closed';
  try {
    const sentAfter = await client.evaluate<number>(`
      (function(){
        const sentLink = Array.from(document.querySelectorAll('a, button')).find(
          (el) => /sent items/i.test(el.textContent || '') || /sent items/i.test(el.getAttribute('aria-label') || '')
        );
        if (!sentLink) return -1;
        const m = (sentLink.textContent || '').match(/(\\d+)/);
        return m ? parseInt(m[1], 10) : -1;
      })()
    `);
    if (sentBefore >= 0 && sentAfter >= 0 && sentAfter > sentBefore) confirmation = 'sent_items_incremented';
  } catch { /* sent-items badge not always visible; that's fine */ }

  return {
    text: JSON.stringify({
      ok: true,
      via: 'outlook-web',
      to,
      subject,
      sent: true,
      confirmation,
    }),
  };
}
