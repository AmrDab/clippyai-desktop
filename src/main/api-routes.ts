/**
 * v0.19.0 PR-6 — API-route stubs for tools that can EITHER drive a real
 * provider API (when the user has stored an API key in Keychain via
 * onboarding step 5 / Settings → Apps) OR fall back to the existing UI-
 * automation path (gmail web, outlook web, etc.).
 *
 * Why this file exists today as STUBS rather than full implementations:
 *   The PR-6 goal is to ship the *routing* infrastructure: hasApiKey()
 *   gating, keychain wiring, the tools.ts branch points. Each API-route
 *   function below currently returns (error:API_NOT_IMPLEMENTED) and
 *   that's intentional — see SPEC v0.19.0 PR-6 §3. v0.20+ will fill these
 *   in one provider at a time (gmail first, then hubspot, notion, …)
 *   without touching tools.ts again. The contract is fixed here so the
 *   incremental API rollouts don't need cross-cutting refactors.
 *
 * Contract for every gmailApiSend / hubspotApiCreate / … function:
 *   - Returns ToolResult { text: string }, same shape as the existing
 *     gmailWebSendEmail. tools.ts can swap one for the other transparently.
 *   - On any failure (missing token, network, parse), prefer falling
 *     through to the UI path rather than surfacing a hard error to the
 *     user. The user's intent ("send mail") doesn't change based on
 *     which transport succeeded.
 */

import type { ToolResult } from './types/tool-result';
import { getSecret } from './skills/secrets';
import { hasApiKey } from './license';
import { createLogger } from './logger';

const log = createLogger('ApiRoutes');

/** Keychain "service" prefix used by all onboarding/Settings-stored API keys. */
export const API_KEYCHAIN_SERVICE = 'clippyai-api';

/**
 * Fetch the stored API token for an app. Returns null if no token,
 * keytar is unavailable (Linux without libsecret), or the presence
 * flag in the store says we never set one. The hasApiKey() guard up
 * front is cheap and avoids unnecessary keychain reads on the hot
 * path (tools.ts calls into here on every email send).
 */
export async function getApiToken(appId: string): Promise<string | null> {
  if (!hasApiKey(appId)) return null;
  try {
    const token = await getSecret(API_KEYCHAIN_SERVICE, appId);
    return token && token.trim().length > 0 ? token : null;
  } catch (err) {
    log.warn('getApiToken failed', { appId, msg: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── Stubs (v0.19.0 PR-6 ships routing only) ──────────────────────────

/**
 * gmail: send-email via the Gmail REST API (users.messages.send w/ a
 * base64url-encoded RFC-2822 message). v0.20+ implements; today this is
 * a stub that signals tools.ts to fall through to the UI-automation
 * path. The (error:…) sentinel matches the conventions in tools.ts so
 * the dispatch chain there continues to outlook-web / gmail-web / clawd.
 */
export async function gmailApiSend(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}): Promise<ToolResult> {
  const token = await getApiToken('gmail');
  if (!token) {
    return { text: '(error:API_NOT_IMPLEMENTED) gmail API route not yet wired in v0.19.0; no token in keychain.' };
  }
  // Suppress the "unused" tsc warning. v0.20 will use these.
  void params;
  return { text: '(error:API_NOT_IMPLEMENTED) gmail API send is stubbed in v0.19.0 PR-6 — UI fallback should run.' };
}

/**
 * hubspot: create a CRM contact/note via the v3 CRM API.
 */
export async function hubspotApiCreate(params: Record<string, unknown>): Promise<ToolResult> {
  const token = await getApiToken('hubspot');
  if (!token) {
    return { text: '(error:API_NOT_IMPLEMENTED) hubspot API route not yet wired in v0.19.0; no token in keychain.' };
  }
  void params;
  return { text: '(error:API_NOT_IMPLEMENTED) hubspot API create is stubbed in v0.19.0 PR-6.' };
}

/**
 * notion: create a page/database row via the official notion-sdk-js
 * shape (we'll fetch().POST directly, no new dependency).
 */
export async function notionApiCreate(params: Record<string, unknown>): Promise<ToolResult> {
  const token = await getApiToken('notion');
  if (!token) {
    return { text: '(error:API_NOT_IMPLEMENTED) notion API route not yet wired in v0.19.0; no token in keychain.' };
  }
  void params;
  return { text: '(error:API_NOT_IMPLEMENTED) notion API create is stubbed in v0.19.0 PR-6.' };
}

/**
 * slack: post message via chat.postMessage. Token is a user-scoped
 * OAuth token from the user's own Slack app, not the workspace bot.
 */
export async function slackApiPostMessage(params: Record<string, unknown>): Promise<ToolResult> {
  const token = await getApiToken('slack');
  if (!token) {
    return { text: '(error:API_NOT_IMPLEMENTED) slack API route not yet wired in v0.19.0; no token in keychain.' };
  }
  void params;
  return { text: '(error:API_NOT_IMPLEMENTED) slack API post is stubbed in v0.19.0 PR-6.' };
}

/**
 * linear: create issue via GraphQL POST. Stubbed for v0.19.0.
 */
export async function linearApiCreateIssue(params: Record<string, unknown>): Promise<ToolResult> {
  const token = await getApiToken('linear');
  if (!token) {
    return { text: '(error:API_NOT_IMPLEMENTED) linear API route not yet wired in v0.19.0; no token in keychain.' };
  }
  void params;
  return { text: '(error:API_NOT_IMPLEMENTED) linear API issue create is stubbed in v0.19.0 PR-6.' };
}

/**
 * github: create issue via Octokit (already a dep). v0.20+ may wire
 * this through; for now stubbed alongside the others so tools.ts can
 * uniformly check hasApiKey('github') first.
 */
export async function githubApiCreateIssue(params: Record<string, unknown>): Promise<ToolResult> {
  const token = await getApiToken('github');
  if (!token) {
    return { text: '(error:API_NOT_IMPLEMENTED) github API route not yet wired in v0.19.0; no token in keychain.' };
  }
  void params;
  return { text: '(error:API_NOT_IMPLEMENTED) github API issue create is stubbed in v0.19.0 PR-6.' };
}

// ── Re-export so tools.ts can keep importing from a single module ────
export { hasApiKey };
