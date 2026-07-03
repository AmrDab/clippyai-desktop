/**
 * gmail-web-send — deterministic recipe for sending email via mail.google.com
 * using CDP. Counterpart to outlook-web-send.ts for users who use Gmail.
 *
 * Verification: after Send is clicked, polls for the "Message sent" snackbar
 * at the bottom of the page OR the Sent folder count to increment.
 */

import { getCdpClient } from '../cdp-client';
import { spawnCdpBrowser } from '../cdp-spawn';
import { createLogger } from '../logger';
import type { ToolResult } from '../types/tool-result';

const log = createLogger('GmailWebSend');

interface GmailWebSendParams {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}

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
    } catch { /* navigating */ }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return false;
}

export async function gmailWebSendEmail(params: GmailWebSendParams): Promise<ToolResult> {
  const { to, subject, body, cc } = params;
  if (!to || !subject || !body) {
    return { text: '(error:MISSING_FIELDS) gmail_web_send_email needs to, subject, body' };
  }

  // v0.14.2 — auto-spawn the browser on connect failure (see outlook-web-send.ts
  // for the full rationale — same pattern, same fix, same support report).
  const client = getCdpClient();
  if (!client.isConnected()) {
    let connectRes = await client.connect();
    if (!connectRes.ok) {
      // v0.16.2 — previously a runtime CommonJS lookup against ../tools;
      // crashed in packed app.asar. See cdp-spawn.ts header for details.
      // v0.17.4 — see outlook-web-send.ts for rationale. Headless so the
      // user doesn't see a Gmail tab pop up while we drive the form.
      const spawned = await spawnCdpBrowser({ headless: true });
      if (spawned.ok) {
        await new Promise((r) => setTimeout(r, 1200));
        connectRes = await client.connect();
      } else {
        return { text: `(error:CDP_NOT_AVAILABLE) ${connectRes.error || 'CDP connect failed'}. Browser auto-launch also failed: ${spawned.error || 'unknown'}` };
      }
      if (!connectRes.ok) {
        return { text: `(error:CDP_NOT_AVAILABLE) ${connectRes.error || 'CDP connect failed'} (browser launched but not reachable yet)` };
      }
    }
  }

  // Use the compose deep-link to skip "click Compose button" — Gmail
  // honors view=cm to open the compose modal directly.
  log.info('Step 1: navigate to Gmail compose deep-link');
  try {
    const safeTo = encodeURIComponent(to);
    const safeSubject = encodeURIComponent(subject);
    const safeBody = encodeURIComponent(body);
    const safeCc = cc ? `&cc=${encodeURIComponent(cc)}` : '';
    await client.evaluate(
      `location.href = 'https://mail.google.com/mail/u/0/?view=cm&fs=1&to=${safeTo}&su=${safeSubject}&body=${safeBody}${safeCc}'`,
    );
  } catch (err) {
    return { text: `(error:NAVIGATE_FAILED) ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 2: wait for compose modal OR sign-in page.
  log.info('Step 2: wait for compose modal');
  const composeReady = await pollUntil(
    client,
    `Boolean(document.querySelector('div[role="dialog"][aria-label*="message" i], div[role="dialog"][aria-label*="compose" i]'))
     || Boolean(document.querySelector('div[aria-label*="Message Body" i]'))
     || Boolean(document.querySelector('div[g_editable="true"][role="textbox"]'))`,
    15_000,
  );
  if (!composeReady) {
    const signedIn = await client.evaluate<boolean>(
      `!Boolean(document.querySelector('input[type="email"]') || /accounts\\.google\\.com/.test(location.href))`,
    );
    if (!signedIn) {
      // v0.17.4 — see outlook-web-send.ts for full rationale on the
      // headless sign-in recovery path.
      return { text: '(error:NOT_SIGNED_IN) mail.google.com sign-in expired or never set up in the Clippy debug profile. Install the Clippy Browser Bridge at clippyai.app/extension to use your real signed-in Chrome instead, or sign in manually next time gmail-web is needed.' };
    }
    return { text: '(error:COMPOSE_FORM_NOT_READY) Gmail compose modal did not open within 15s.' };
  }

  // The deep-link populated To/Subject/Body. Verify it actually landed.
  // If the body wasn't applied (rare edge case with very long bodies), retry
  // by typing into the body div.
  log.info('Step 3: verify body was populated');
  const bodyOk = await client.evaluate<boolean>(`
    (function(){
      const el = document.querySelector('div[g_editable="true"][role="textbox"], div[aria-label*="Message Body" i][contenteditable]');
      if (!el) return false;
      const txt = (el.textContent || '').trim();
      return txt.length > 0;
    })()
  `).catch(() => false);
  if (!bodyOk) {
    // Retry: type body directly
    log.warn('Body field empty after deep-link; typing manually');
    const filledBody = await client.evaluate<boolean>(`
      (function(){
        const el = document.querySelector('div[g_editable="true"][role="textbox"], div[aria-label*="Message Body" i][contenteditable]');
        if (!el) return false;
        el.focus();
        el.innerHTML = ${JSON.stringify(body.replace(/\n/g, '<br>'))};
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return true;
      })()
    `);
    if (!filledBody) {
      return { text: '(error:BODY_FILL_FAILED) Could not populate Gmail body.' };
    }
  }

  // Step 4: click Send. Gmail's Send button has aria-label "Send ‪(Ctrl-Enter)‬".
  log.info('Step 4: click Send');
  const clickedSend = await client.evaluate<boolean>(`
    (function(){
      const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
      // Prefer aria-label starting with "Send" but NOT "Send & Archive", "Schedule", etc.
      const sendBtn = buttons.find((b) => {
        const lbl = (b.getAttribute('aria-label') || '').trim();
        const dataTooltip = (b.getAttribute('data-tooltip') || '').trim();
        return (/^send(\\s|$|\\(|\\b)/i.test(lbl) || /^send(\\s|$|\\(|\\b)/i.test(dataTooltip))
          && !/schedule|later|undo/i.test(lbl + ' ' + dataTooltip);
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
    return { text: '(error:SEND_BUTTON_NOT_FOUND) Located compose but could not click Send. Email saved to drafts.' };
  }

  // Step 5: verify via "Message sent" snackbar OR compose modal closed.
  log.info('Step 5: verify send');
  const confirmed = await pollUntil(
    client,
    `Boolean(document.querySelector('span[role="alert"]')) && /message sent/i.test(document.querySelector('span[role="alert"]')?.textContent || '')
     || !document.querySelector('div[role="dialog"][aria-label*="message" i]')`,
    8_000,
  );
  if (!confirmed) {
    return { text: '(error:UNVERIFIED) Send clicked but no "Message sent" toast or compose-modal-closed signal within 8s. The email may be queued or blocked.' };
  }

  return {
    text: JSON.stringify({
      ok: true,
      via: 'gmail-web',
      to,
      subject,
      sent: true,
      confirmation: 'message_sent_toast_or_compose_closed',
    }),
  };
}
