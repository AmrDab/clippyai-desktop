/**
 * governor.ts — risky-action governor (v0.21).
 *
 * Pure, synchronous classifier. Given a desktop-input tool call plus whatever
 * context the caller could resolve cheaply (the label it is about to click,
 * the page URL, the key chord, the active window title) it answers: "does
 * this look like money / a send / a delete / an app-kill?" If so it returns
 * the Clippy actionClass the call should be ESCALATED to before it runs, and
 * a one-line reason for the approval bubble. `null` means "nothing risky
 * recognised — keep the tool's static actionClass".
 *
 * The permission policy (permission-policy.ts) then decides with the
 * escalated class exactly as it would for a natively-destructive tool, so an
 * escalated click behaves like outlook_send_email / delete_file under every
 * Guardrails mode: standard + cautious ask, trusted asks only for purchases
 * (and for whatever the user overrides per class).
 *
 * Patterns are ported from plip-oss `src/mcp_vision/core/governor.py`
 * (MIT, Copyright (c) 2026 Hussain) and adapted to Clippy's class model.
 * Matching is case-insensitive on word boundaries; `-`/`_` in selectors are
 * treated as spaces so `#place-order-btn` reads as "place order btn".
 *
 * Deliberate departures from plip (each one is a judgement call):
 *   - bare "order", "book", "booking", "trash", "post"-as-noun are NOT risky
 *     ("Order history", "Address Book", the Trash folder, the "Posts" tab).
 *     Only the verb forms are ("place order", "book now", "empty trash").
 *   - "add to cart" is NOT risky — reversible, no money moves until checkout.
 *   - "payment method(s)/history/settings" is navigation, not a payment.
 *   - "remove filter(s)/formatting/highlight/sort" is cosmetic.
 *   - "terminal", "iterm", "sudo", "root" labels are dropped: clicking a
 *     Terminal icon launches an app (system_control, allowed in standard).
 *     Shell execution is governed by shell_exec's own destructive_exec class.
 *   - "send/submit feedback" stays risky: it still posts text under the
 *     user's identity.
 *   - Enter/Return is escalated only when the caller supplies a context
 *     (window title / page URL) that looks like a compose or checkout
 *     surface. plip escalates every Enter; for Clippy that would prompt on
 *     every search box.
 */

import type { ActionClass } from './tool-meta';

export interface RiskInput {
  tool: string;
  args: Record<string, unknown>;
  /** Label of the element about to be clicked/typed into, when known. */
  resolvedLabel?: string;
  /** Page URL (CDP / browser tools). */
  url?: string;
  /** Key chord for key_press, e.g. "ctrl+enter". */
  keys?: string;
  /** Active window title / focused element name — used for coordinate clicks + Enter. */
  context?: string;
}

export interface RiskVerdict {
  class: ActionClass;
  reason: string;
}

/** Tools the governor looks at. Anything else returns null immediately. */
export const GOVERNED_TOOLS: ReadonlySet<string> = new Set([
  'smart_click', 'mouse_click', 'mouse_double_click', 'key_press', 'smart_type', 'type_text',
  'cdp_click', 'cdp_type', 'browser_click', 'browser_type',
]);

const CLICK_TOOLS = new Set(['smart_click', 'mouse_click', 'mouse_double_click', 'cdp_click', 'browser_click']);
const TYPE_TOOLS = new Set(['smart_type', 'type_text', 'cdp_type', 'browser_type']);

// ── Label patterns (grouped by the actionClass they escalate to) ──────────

interface LabelRule { re: RegExp; cls: ActionClass; what: string }

const LABEL_RULES: LabelRule[] = [
  { cls: 'destructive_purchase', what: 'purchase',
    re: /\b(buy(\s+now)?|purchase|pay(\s+now)?|payment|check\s?out|place\s+(your\s+|the\s+|my\s+)?order|order\s+now|(confirm|complete|submit)\s+(your\s+|the\s+|my\s+)?(order|purchase|payment|booking)|complete\s+purchase|confirm\s+payment|book\s+now|reserve|transfer|wire|authori[sz]e\s+payment)\b/i },
  { cls: 'destructive_send', what: 'send',
    re: /\b(send|submit|reply\s+all|send\s+(now|email|message|invite))\b/i },
  { cls: 'share_public', what: 'publish',
    re: /\b(publish|post|share\s+(now|publicly|to))\b/i },
  { cls: 'destructive_file', what: 'delete',
    re: /\b(delete|remove|erase|wipe|destroy|discard|uninstall|format|empty\s+trash|move\s+to\s+trash)\b/i },
  { cls: 'destructive_web', what: 'subscription',
    re: /\b(subscribe)\b/i },
  { cls: 'destructive_exec', what: 'confirmation',
    re: /\b(confirm|authori[sz]e)\b/i },
];

/** Labels that contain a risky word but are benign. Checked first. */
const LABEL_EXCLUSIONS: RegExp[] = [
  /\b(add\s+to\s+cart)\b/i,
  /\b(payment\s+(methods?|history|options?|settings))\b/i,
  /\b(remove\s+(filters?|formatting|highlight|sort))\b/i,
  /\b(order\s+(history|details|status)|my\s+orders|sort\s+order|order\s+by)\b/i,
  /\b(transfer\s+(files?|data|settings))\b/i,
  /\b(post\s+office|posts|blog\s+posts|format\s+(painter|text|cells?|paragraph))\b/i,
  /\b(confirm(ed|ation)\s+(email|number|code))\b/i,
];

/** Credential-shaped fields: typing into them escalates. */
const CREDENTIAL_LABEL = /\b(password|passwd|passcode|pin|ssn|social\s+security|cvv|cvc|security\s+code|card\s+number)\b/i;

// ── URL patterns ─────────────────────────────────────────────────────────

const PURCHASE_URL = /(\/(checkout|cart|payment|billing|purchase|buy|order\/confirm|place.?order)(\/|$|\?|#)|checkout\.stripe\.com|paypal\.com\/(cgi-bin\/webscr|checkout))/i;
const COMPOSE_URL = /(\/compose(\/|$|\?|#)|mail\.google\.com\/.*#?compose|outlook\.(live|office)\.com\/mail\/.*\/compose|#compose)/i;

/** Window titles / focused-element names that mark a send or pay surface. */
const SEND_CONTEXT = /\b(compose|new message|untitled - message|write message)\b/i;
const PURCHASE_CONTEXT = /\b(checkout|place order|payment|billing|review your order|place your order)\b/i;

// ── Key chords ───────────────────────────────────────────────────────────

// Compared after normalizeChord (control→ctrl, command/meta→cmd, option→alt, delete→del).
const RISKY_CHORDS = new Set(['alt+f4', 'ctrl+alt+del', 'cmd+q', 'cmd+shift+q', 'cmd+alt+esc']);
const ENTER_KEYS = new Set(['enter', 'return', 'ctrl+enter', 'ctrl+return', 'cmd+enter', 'cmd+return']);

function normalizeLabel(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeChord(keys: string): string {
  return keys.toLowerCase().split('+').map((k) => k.trim()).filter(Boolean)
    .map((k) => (k === 'control' ? 'ctrl' : k === 'option' ? 'alt' : k === 'command' || k === 'meta' ? 'cmd' : k === 'delete' ? 'del' : k))
    .join('+');
}

function q(s: string): string {
  return s.length > 48 ? `'${s.slice(0, 45)}…'` : `'${s}'`;
}

/** Risk from a clickable label. Exported for tests; `null` when benign. */
export function classifyLabel(label: string): RiskVerdict | null {
  const norm = normalizeLabel(label);
  if (!norm) return null;
  if (LABEL_EXCLUSIONS.some((re) => re.test(norm))) return null;
  for (const rule of LABEL_RULES) {
    const m = rule.re.exec(norm);
    if (m) return { class: rule.cls, reason: `Looks like a ${rule.what} button: ${q(norm)}` };
  }
  return null;
}

/** Risk from a page URL. `null` when the URL is not a pay/send surface. */
export function classifyUrl(url: string): RiskVerdict | null {
  if (!url) return null;
  let blob = url;
  try {
    const u = new URL(url);
    blob = `${u.host}${u.pathname}?${u.search}#${u.hash}`;
  } catch { /* match the raw string */ }
  if (PURCHASE_URL.test(blob)) return { class: 'destructive_purchase', reason: `This page looks like a checkout/payment page (${q(url)})` };
  if (COMPOSE_URL.test(blob)) return { class: 'destructive_send', reason: `This page looks like a mail compose window (${q(url)})` };
  return null;
}

function classifyContext(context: string): RiskVerdict | null {
  if (!context) return null;
  if (PURCHASE_CONTEXT.test(context)) return { class: 'destructive_purchase', reason: `The active window looks like a checkout (${q(context)})` };
  if (SEND_CONTEXT.test(context)) return { class: 'destructive_send', reason: `The active window looks like a message being composed (${q(context)})` };
  return null;
}

/** Risk from a key chord. Enter only escalates with a send/pay context. */
export function classifyKeys(keys: string, context?: string, url?: string): RiskVerdict | null {
  const chord = normalizeChord(keys);
  if (!chord) return null;
  if (RISKY_CHORDS.has(chord)) {
    return { class: 'destructive_exec', reason: `${keys} closes or kills the current app` };
  }
  if (ENTER_KEYS.has(chord)) {
    const v = (url ? classifyUrl(url) : null) ?? (context ? classifyContext(context) : null);
    if (v) return { class: v.class, reason: `${keys} would probably ${v.class === 'destructive_purchase' ? 'submit the order' : 'send the message'} — ${v.reason}` };
  }
  return null;
}

/** Label the tool is about to act on, from its args. */
export function labelFromArgs(tool: string, args: Record<string, unknown>): string {
  if (tool === 'smart_click' || tool === 'smart_type') return String(args.target ?? '');
  if (tool === 'cdp_click' || tool === 'browser_click') return String(args.text ?? args.selector ?? '');
  if (tool === 'cdp_type' || tool === 'browser_type') return String(args.label ?? args.selector ?? '');
  return '';
}

/**
 * Main entry. Returns the escalated class + reason, or null.
 * Precedence: credential field (type tools) → label → URL/context (click
 * tools and Enter-type keys only; typing on a checkout page is fine).
 */
export function classifyRisk(input: RiskInput): RiskVerdict | null {
  const { tool, args } = input;
  if (!GOVERNED_TOOLS.has(tool)) return null;

  const label = input.resolvedLabel ?? labelFromArgs(tool, args);

  if (TYPE_TOOLS.has(tool) && label && CREDENTIAL_LABEL.test(normalizeLabel(label))) {
    return { class: 'destructive_send', reason: `Typing into a credential field: ${q(normalizeLabel(label))}` };
  }

  if (tool === 'key_press') {
    return classifyKeys(input.keys ?? String(args.key ?? ''), input.context, input.url);
  }

  if (label) {
    const v = classifyLabel(label);
    if (v) return v;
  }

  // type_text ending in a newline submits whatever has focus.
  if (tool === 'type_text') {
    const text = String(args.text ?? '');
    if (/[\r\n]$/.test(text)) return classifyKeys('enter', input.context, input.url);
    return null;
  }

  if (CLICK_TOOLS.has(tool)) {
    if (input.url) {
      const v = classifyUrl(input.url);
      if (v) return v;
    }
    if (input.context) {
      const v = classifyContext(input.context);
      if (v) return v;
    }
  }
  return null;
}
