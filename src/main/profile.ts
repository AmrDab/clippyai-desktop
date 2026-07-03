/**
 * profile.ts — Clippy's user-and-self profile system.
 *
 * Modeled on openclaw's workspace convention (IDENTITY.md / USER.md /
 * SOUL.md / MEMORY.md). Lives at userData/profile/ on disk and is
 * loaded into the worker's system prompt on every /v1/turn so the
 * model can tailor replies to who the user is, what apps they use,
 * how they want to be addressed, and what Clippy has learned about
 * them over time.
 *
 * Files:
 *   - IDENTITY.md  Clippy's identity for THIS install (buddyName,
 *                  vibe preset, voice). Written at onboarding-complete,
 *                  edited via Settings.
 *   - USER.md      Who the user is (name, timezone,
 *                  apps, preferences). Written at onboarding-complete,
 *                  appended-to as Clippy learns more.
 *   - SOUL.md      Shipped principles. Read-only at runtime; user can
 *                  edit on disk if they want deep customization.
 *   - MEMORY.md    Long-term curated learnings (durable user prefs).
 *                  Brain appends here when it learns something stable.
 *
 * Compat: the legacy single `user.md` at userData root is still
 * supported — `getUserProfile()` falls back to it when profile/USER.md
 * doesn't exist, so v0.20.0-alpha.5 users don't lose their saved name
 * during the alpha.6 upgrade.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger';
// v0.20.0-alpha.13 — instincts (learned self-corrections). Static
// namespace import so Rollup never tree-shakes the module body away
// (see feedback_clippy_bundle_anchors.md — sixth-time-is-the-charm).
import * as instinctsMod from './instincts';
// v0.20.0 — Phase 1 semantic memory recall. Static namespace import so
// Rollup never tree-shakes it away (feedback_clippy_bundle_anchors.md).
// Recall is best-effort; every call site falls back to the legacy
// whole-MEMORY.md behaviour if recall is unavailable or empty.
import * as memoryRecall from './memory-recall';

const log = createLogger('Profile');

// Templates are imported as raw strings at build time so they survive
// the electron-vite + asar bundle without us having to ship the .tpl
// files as extraResources or do runtime path resolution into a packed app.
// @ts-expect-error — Vite's ?raw query has no TS type out of the box
import IDENTITY_TPL from './profile/templates/IDENTITY.md.tpl?raw';
// @ts-expect-error — Vite ?raw
import USER_TPL from './profile/templates/USER.md.tpl?raw';
// @ts-expect-error — Vite ?raw
import SOUL_TPL from './profile/templates/SOUL.md.tpl?raw';
// @ts-expect-error — Vite ?raw
import MEMORY_TPL from './profile/templates/MEMORY.md.tpl?raw';
// @ts-expect-error — Vite ?raw
import BOOTSTRAP_TPL from './profile/templates/BOOTSTRAP.md.tpl?raw';

// v0.20.0-alpha.8 — BOOTSTRAP.md added to the workspace. Per openclaw
// pattern (docs.openclaw.ai/start/bootstrapping): a one-time runbook the
// model follows on first-run-after-install to fill USER/IDENTITY fields
// through natural chat (one question per turn). The model is expected
// to call `finish_onboarding_chat` when done, which deletes this file
// so the ritual never fires again.
const PROFILE_FILES = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md', 'BOOTSTRAP.md'] as const;
type ProfileFile = typeof PROFILE_FILES[number];

const TEMPLATES: Record<ProfileFile, string> = {
  'IDENTITY.md': IDENTITY_TPL,
  'USER.md': USER_TPL,
  'SOUL.md': SOUL_TPL,
  'MEMORY.md': MEMORY_TPL,
  'BOOTSTRAP.md': BOOTSTRAP_TPL,
};

function getProfileDir(): string {
  return path.join(app.getPath('userData'), 'profile');
}

function ensureProfileDir(): void {
  const dir = getProfileDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getProfileFilePath(name: ProfileFile): string {
  return path.join(getProfileDir(), name);
}

function getLegacyUserMdPath(): string {
  return path.join(app.getPath('userData'), 'user.md');
}

function loadTemplate(name: ProfileFile): string {
  return TEMPLATES[name];
}

function applySubstitutions(template: string, subs: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return subs[key] ?? `_(not set)_`;
  });
}

export interface OnboardingProfileData {
  buddyName: string;
  vibe?: string;
  ttsVoice: string;
  userName: string;
  timezone?: string;
  userApps?: string[];
  replyStyle?: string;
  proactiveLevel?: string;
}

/**
 * Write the five profile files at onboarding completion. Idempotent —
 * if the user re-runs onboarding (e.g. via Settings → "Reset onboarding")
 * the files are re-templated from the current data. SOUL.md is only
 * written if it doesn't exist, since it's shipped and the user may
 * have edited it.
 */
export function writeOnboardingProfile(data: OnboardingProfileData): void {
  ensureProfileDir();
  const now = new Date().toISOString().split('T')[0];
  const subs: Record<string, string> = {
    buddyName: data.buddyName || 'Clippy',
    vibe: data.vibe || 'friendly',
    ttsVoice: data.ttsVoice || 'system default',
    createdAt: now,
    userName: data.userName || '(not set)',
    timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    userApps: (data.userApps && data.userApps.length > 0) ? data.userApps.join(', ') : '(none picked)',
    replyStyle: data.replyStyle || 'concise',
    proactiveLevel: data.proactiveLevel || 'default',
  };

  const writeFile = (name: ProfileFile, overwrite: boolean): void => {
    const dest = getProfileFilePath(name);
    if (!overwrite && fs.existsSync(dest)) return;
    const body = applySubstitutions(loadTemplate(name), subs);
    fs.writeFileSync(dest, body, 'utf-8');
  };

  writeFile('IDENTITY.md', true);
  writeFile('USER.md', true);
  writeFile('SOUL.md', false);   // ship-once, user may edit
  writeFile('MEMORY.md', false); // accumulates — never overwrite
  writeFile('BOOTSTRAP.md', true); // one-shot ritual; finish_onboarding_chat deletes it
  log.info('Profile written', { dir: getProfileDir(), files: PROFILE_FILES });
}

/**
 * Delete BOOTSTRAP.md. Called when the model emits
 * `finish_onboarding_chat` to end the first-run ritual. Idempotent —
 * silent if the file doesn't exist (ritual already finished, or never
 * ran on this install).
 */
export function deleteBootstrap(): void {
  const p = getProfileFilePath('BOOTSTRAP.md');
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      log.info('BOOTSTRAP.md deleted — onboarding ritual complete');
    }
  } catch (err) {
    log.warn('Failed to delete BOOTSTRAP.md (non-fatal)', err);
  }
}

/**
 * Is the onboarding ritual still pending? True when BOOTSTRAP.md is
 * still on disk. The brain checks this on first wake-after-onboarding
 * to decide whether to fire the first proactive message.
 */
export function isBootstrapPending(): boolean {
  return fs.existsSync(getProfileFilePath('BOOTSTRAP.md'));
}

/**
 * Load all five profile files concatenated as one string for the
 * worker's user_profile context. ~2-4 KB typically — well within
 * any model's token budget.
 *
 * Returns the empty string if no files exist (pre-onboarding state),
 * which signals the worker to use a generic system prompt.
 *
 * v0.20.0-alpha.13 — accepts an optional `userText`. When provided,
 * the matched-instincts block is appended so the worker model gets
 * Clippy's learned self-corrections inlined with the rest of the
 * profile bundle. Callers can omit `opts` to preserve legacy behaviour.
 *
 * v0.20.0 (Phase 1 semantic memory) — now async. IDENTITY/USER/SOUL.md
 * are still injected whole. MEMORY.md is replaced by a SEMANTIC RECALL:
 * we ask memory-recall for the top-K entries relevant to `userText` and
 * inject only those. If recall isn't ready / returns nothing / throws we
 * fall back to injecting MEMORY.md whole — exactly today's behaviour — so
 * the user is never worse off.
 */
export async function loadProfileBundle(opts?: { userText?: string }): Promise<string> {
  ensureProfileDir();

  // Compat: migrate legacy user.md to profile/USER.md if present and new file missing.
  const userMdNew = getProfileFilePath('USER.md');
  const userMdLegacy = getLegacyUserMdPath();
  if (!fs.existsSync(userMdNew) && fs.existsSync(userMdLegacy)) {
    try {
      const legacy = fs.readFileSync(userMdLegacy, 'utf-8');
      fs.writeFileSync(userMdNew, legacy, 'utf-8');
      log.info('Migrated legacy user.md → profile/USER.md');
    } catch (err) {
      log.warn('Legacy user.md migration failed (non-fatal)', err);
    }
  }

  // Kick off the one-time, lazy, background reindex of MEMORY.md into the
  // vector store. Never blocks: until it finishes, recall returns [] and
  // we fall back to the whole file below, so users are never worse off.
  maybeKickBackgroundReindex();

  const userText = opts && typeof opts.userText === 'string' ? opts.userText.trim() : '';

  const parts: string[] = [];
  for (const name of PROFILE_FILES) {
    const p = getProfileFilePath(name);
    if (!fs.existsSync(p)) continue;

    // MEMORY.md: try semantic recall first, fall back to whole-file.
    if (name === 'MEMORY.md') {
      const recalled = await tryRecallMemoryBlock(userText);
      if (recalled) {
        parts.push(recalled);
        continue;
      }
      // else: fall through to whole-file injection below.
    }

    try {
      const body = fs.readFileSync(p, 'utf-8').trim();
      if (body) parts.push(`=== ${name} ===\n${body}`);
    } catch (err) {
      log.warn(`Could not load ${name}`, err);
    }
  }

  // Append matched instincts when the caller passed the current user
  // turn text. We swallow any error — instincts is a soft-rules layer
  // and must never break profile loading.
  if (userText) {
    try {
      const block = instinctsMod.renderInstinctsForUserText(userText);
      if (block) parts.push(block);
    } catch (err) {
      log.warn('Instincts render failed (non-fatal)', err);
    }
  }

  return parts.join('\n\n');
}

/**
 * Try to build the `=== RELEVANT MEMORY ===` block via semantic recall.
 * Returns the formatted block string, or null to signal "fall back to
 * injecting MEMORY.md whole". null is returned when there's no user text,
 * recall isn't ready, no entry crosses the relevance floor, or anything
 * throws — i.e. any reason today's whole-file behaviour is the safer bet.
 */
async function tryRecallMemoryBlock(userText: string): Promise<string | null> {
  if (!userText) return null;
  try {
    const matches = await memoryRecall.recallTopK(userText, 6);
    if (!matches || matches.length === 0) return null;
    const block = memoryRecall.renderRecallBlock(matches);
    return block || null;
  } catch (err) {
    log.warn('Memory recall failed (non-fatal — using whole MEMORY.md)', err);
    return null;
  }
}

let backgroundReindexStarted = false;

/**
 * Fire-and-forget the first-run reindex of MEMORY.md into the vector store.
 * Runs at most once per process, only when the vector store reports it
 * needs migration (fresh install or embedding-model change). Parses the
 * existing MEMORY.md bullets and hands them to memory-recall.reindexAll().
 * Fully non-blocking + error-swallowing.
 */
function maybeKickBackgroundReindex(): void {
  if (backgroundReindexStarted) return;
  backgroundReindexStarted = true;
  try {
    if (!memoryRecall.needsMigration()) return;
    memoryRecall.clearMigrationFlag();
    const entries = parseMemoryBullets();
    if (entries.length === 0) return;
    // Detach: we never await this from the turn path.
    void memoryRecall
      .reindexAll(entries)
      .catch((err) => log.warn('Background MEMORY.md reindex failed (non-fatal)', err));
    log.info('Kicked background MEMORY.md reindex', { entries: entries.length });
  } catch (err) {
    log.warn('maybeKickBackgroundReindex threw (non-fatal)', err);
  }
}

/**
 * Parse MEMORY.md into `{ text, ts }` entries — one per `- bullet` line.
 * Pulls the trailing `_(YYYY-MM-DD)_` date written by appendMemory() into
 * `ts` (falling back to now), and strips it from `text`.
 */
function parseMemoryBullets(): Array<{ text: string; ts: number }> {
  const p = getProfileFilePath('MEMORY.md');
  if (!fs.existsSync(p)) return [];
  let body: string;
  try {
    body = fs.readFileSync(p, 'utf-8');
  } catch {
    return [];
  }
  const out: Array<{ text: string; ts: number }> = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    let text = line.slice(2).trim();
    let ts = Date.now();
    const dateMatch = text.match(/_\((\d{4}-\d{2}-\d{2})\)_\s*$/);
    if (dateMatch) {
      const parsed = Date.parse(dateMatch[1]);
      if (Number.isFinite(parsed)) ts = parsed;
      text = text.replace(/_\(\d{4}-\d{2}-\d{2}\)_\s*$/, '').trim();
    }
    if (text) out.push({ text, ts });
  }
  return out;
}

/**
 * Append a one-line learning to MEMORY.md. Used by the brain when it
 * notices a durable user preference (e.g. "user prefers Apple Mail"
 * after watching them pick it twice). Caller is responsible for
 * deduping — this just appends.
 */
export function appendMemory(note: string): void {
  ensureProfileDir();
  const p = getProfileFilePath('MEMORY.md');
  const ts = new Date().toISOString().split('T')[0];
  const line = `\n- ${note} _(${ts})_`;
  try {
    if (fs.existsSync(p)) {
      fs.appendFileSync(p, line, 'utf-8');
    } else {
      fs.writeFileSync(p, `# MEMORY.md — Things Clippy Has Learned\n${line}\n`, 'utf-8');
    }
    log.info('Memory appended', { note: note.slice(0, 80) });
  } catch (err) {
    log.error('Could not append to MEMORY.md', err);
  }

  // v0.20.0 Phase 1 — keep the vector index in sync with the file.
  // Fire-and-forget: embedding is best-effort and must never block (or
  // break) the write path. Errors are swallowed inside indexMemory + here.
  try {
    void memoryRecall
      .indexMemory({ text: note, ts: Date.now() })
      .catch((err) => log.warn('indexMemory failed (non-fatal)', err));
  } catch (err) {
    log.warn('indexMemory dispatch threw (non-fatal)', err);
  }
}

/**
 * Parse the USER.md file's structured fields for places that just need
 * the name/role/etc — Settings UI, IPC handlers, etc.
 */
export function getUserFields(): Record<string, string> {
  const p = getProfileFilePath('USER.md');
  if (!fs.existsSync(p)) {
    // Legacy fallback.
    const legacy = getLegacyUserMdPath();
    if (!fs.existsSync(legacy)) return {};
    return parseFields(fs.readFileSync(legacy, 'utf-8'));
  }
  return parseFields(fs.readFileSync(p, 'utf-8'));
}

function parseFields(md: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const regex = /- \*\*([^:]+):\*\*\s*(.+)/g;
  let m;
  while ((m = regex.exec(md)) !== null) {
    const key = m[1].trim();
    const val = m[2].trim();
    if (val && !val.startsWith('_(') && val !== '(not set)') fields[key] = val;
  }
  return fields;
}

/**
 * Update one or more fields in USER.md, preserving the rest of the
 * file (so user-written prose in the "Context" section survives).
 * Creates USER.md from template if it doesn't exist yet.
 */
export function updateUserFields(updates: Record<string, string>): void {
  ensureProfileDir();
  const p = getProfileFilePath('USER.md');
  let content: string;
  if (fs.existsSync(p)) {
    content = fs.readFileSync(p, 'utf-8');
  } else {
    content = applySubstitutions(loadTemplate('USER.md'), { userName: '(not set)' });
  }
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`(-\\s+\\*\\*${key}:\\*\\*\\s+)(.*)`);
    if (re.test(content)) {
      content = content.replace(re, `$1${value}`);
    } else {
      // Field doesn't exist yet — insert after the "About You" header.
      content = content.replace(/(# USER\.md[^\n]*\n[^\n]*\n\n)/, `$1- **${key}:** ${value}\n`);
    }
  }
  try {
    fs.writeFileSync(p, content, 'utf-8');
    log.info('USER.md updated', { keys: Object.keys(updates) });
  } catch (err) {
    log.error('Failed to update USER.md', err);
  }
}

export function isProfileInitialized(): boolean {
  return fs.existsSync(getProfileFilePath('USER.md')) || fs.existsSync(getLegacyUserMdPath());
}
