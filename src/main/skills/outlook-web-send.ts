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
      // v0.17.4 — spawn headless. The whole recipe is programmatic CDP;
      // the user never needed to see the browser. Per support report
      // f6c85a04: "clippy sent email well, though opened a browser tab
      // for no reason." Headless eliminates that side effect entirely.
      const spawned = await spawnCdpBrowser({ headless: true });
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
      // v0.17.4 — headless spawn means the user CAN'T see a sign-in prompt.
      // Give a clear recovery path: tell them to install the Browser Bridge
      // (uses their real signed-in Chrome — no separate profile to sign into)
      // or sign in manually to the Clippy debug profile by visiting
      // outlook.live.com in their normal browser… which actually won't help
      // because the debug profile is separate. Best long-term recovery is
      // mcp-chrome extension. Short-term: surface honestly so the model can
      // suggest Tier 5 / clawdcursor or ask the user.
      return { text: '(error:NOT_SIGNED_IN) outlook.live.com sign-in expired or never set up in the Clippy debug profile. Install the Clippy Browser Bridge at clippyai.app/extension to use your real signed-in Chrome instead, or sign in manually next time outlook-web is needed.' };
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

  // Step 10: verify the send.
  //
  // History — see support report 543ff234 (2026-05-11) and the same
  // false-positive pattern still firing in v0.17.5 (2026-05-15). Previous
  // implementation treated "compose form is gone" as proof of send and
  // returned `sent: true`. That's wrong. Outlook closes the compose form
  // on multiple events: Send-clicked-successfully, Cancel-clicked,
  // Discard-clicked, accidental Esc, even network-blip + auto-save +
  // dismiss. Returning `sent: true` on bare compose-closed produced the
  // "Clippy claimed to send the email but no email was sent" bug.
  //
  // New rule: a "compose closed" signal is NECESSARY but NOT SUFFICIENT.
  // We require ONE of three positive signals within ~6s of compose
  // closing, AND we check for negative signals (error toasts / blocked
  // dialogs) before claiming success:
  //
  //   POSITIVE — any one of:
  //     • "Sent" or "Message sent" toast appears
  //     • Sent Items folder badge count increments (sentAfter > sentBefore)
  //     • URL navigates to /mail/sentitems
  //
  //   NEGATIVE — any one of:
  //     • Error toast: /couldn't send|unable to send|failed to send|recipient.+(invalid|not found)/i
  //     • A dialog/alert appears containing similar text
  //
  // If no positive signal AND no negative signal land in time, return
  // sent: 'unverified' with the actual observed state. The brain has a
  // matching instruction not to claim success on unverified — the user
  // is told "I clicked Send but couldn't confirm it actually went out;
  // please check your Sent Items."
  log.info('Step 10: verify send');
  const composeClosed = await pollUntil(
    client,
    `!document.querySelector('input[aria-label="Subject"], input[placeholder="Add a subject"]')`,
    8_000,
  );
  if (!composeClosed) {
    return { text: '(error:UNVERIFIED) Send button clicked but compose form is still open. The send may have been blocked by a confirmation dialog (recipient validation, missing attachment).' };
  }

  // After compose closes, race positive and negative confirmations.
  // Whichever fires first wins. ~6s total budget.
  const VERIFY_MS = 6_000;
  const POSITIVE_JS = `
    (function(){
      // (a) explicit toast or live-region announcement
      const toastText = Array.from(document.querySelectorAll(
        '[role="alert"], [role="status"], [aria-live], .ms-MessageBar-text, [class*="Toast"], [class*="Snackbar"]'
      )).map(n => (n.textContent || '').trim()).join(' | ').toLowerCase();
      if (/\\b(sent|message sent|email sent|your message has been sent|sending)\\b/.test(toastText)) return 'toast';
      // (b) navigation to Sent Items view (URL is the authoritative source)
      const path = (location.pathname || '').toLowerCase();
      if (path.includes('/mail/sentitems') || path.includes('/sent%20items') || path.endsWith('/sentitems')) return 'url_sentitems';
      // (c) sent-items folder badge incremented
      const sentLink = Array.from(document.querySelectorAll('a, button, [role="treeitem"]')).find(
        (el) => /sent items/i.test(el.textContent || '') || /sent items/i.test(el.getAttribute('aria-label') || '')
      );
      if (sentLink) {
        const m = (sentLink.textContent || '').match(/(\\d+)/);
        const n = m ? parseInt(m[1], 10) : -1;
        if (n > __SENT_BEFORE__) return 'sent_items_incremented';
      }
      return null;
    })()
  `.replace('__SENT_BEFORE__', String(sentBefore));

  const NEGATIVE_JS = `
    (function(){
      const toastText = Array.from(document.querySelectorAll(
        '[role="alert"], [role="status"], [role="dialog"], [aria-live], .ms-MessageBar-text, [class*="Toast"], [class*="Snackbar"]'
      )).map(n => (n.textContent || '').trim()).join(' | ');
      const m = toastText.match(/(?:couldn['\\u2019]?t|unable to|failed to|cannot)\\s+send|recipient.+(?:invalid|not found|unknown)|message (?:wasn['\\u2019]?t|was not) sent/i);
      return m ? m[0] : null;
    })()
  `;

  let confirmation: string | null = null;
  let blockingError: string | null = null;
  const deadline = Date.now() + VERIFY_MS;
  while (Date.now() < deadline) {
    try {
      const neg = await client.evaluate<string | null>(NEGATIVE_JS);
      if (neg) { blockingError = neg; break; }
      const pos = await client.evaluate<string | null>(POSITIVE_JS);
      if (pos) { confirmation = pos; break; }
    } catch { /* page churn during navigation; retry */ }
    await new Promise((res) => setTimeout(res, 350));
  }

  if (blockingError) {
    return {
      text: JSON.stringify({
        ok: false,
        via: 'outlook-web',
        to,
        subject,
        sent: false,
        error: 'send_blocked',
        detail: blockingError.slice(0, 200),
      }),
    };
  }

  if (!confirmation) {
    // Compose closed but no positive signal in 6s and no error. The most
    // common cause is that Outlook routed to Inbox without showing a
    // toast (no badge animation either). We refuse to claim success.
    return {
      text: JSON.stringify({
        ok: true,
        via: 'outlook-web',
        to,
        subject,
        sent: 'unverified',
        confirmation: 'compose_closed_only',
        warning: 'compose_form_closed_but_send_not_confirmed — verify by checking Sent Items',
      }),
    };
  }

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
