/**
 * contextual-suggestions.ts — v0.19.0 PR-3
 *
 * Pure rule-registry that fires BEFORE the Kimi K2 model call in
 * proactiveCheck(). A rule hit saves a full round-trip + tokens for
 * the common 60-70% of situations where a deterministic tip is
 * unambiguously the right answer.
 *
 * Design invariants:
 *   - Zero Electron imports. Zero IPC. Import only `fs` and `os` (OS-agnostic).
 *   - All exported — unit-testable from smoke.js without requiring Electron.
 *   - Order in RULES matters: match() returns the FIRST passing rule.
 *     Put specific rules before broad ones.
 *
 * Cross-platform note (Windows):
 *   On Windows the `app` field from get_active_window is the process name
 *   (e.g. "outlook.exe", "chrome.exe"). On macOS it is the app display name
 *   (e.g. "Mail", "Code"). Each rule's `app` regex includes BOTH forms.
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ClippyEnergy = 'subtle' | 'default' | 'lively';

export interface SuggestionContext {
  /** processName from get_active_window */
  app: string;
  windowTitle: string;
  /** powerMonitor.getSystemIdleTime() */
  idleSec: number;
  /** fs.readdirSync(~/Downloads).length — cached 60s */
  downloadsCount?: number;
  /** ~/Desktop Screenshot*.png count — cached 60s */
  screenshotsCount?: number;
  hourOfDay: number;
}

export interface SuggestionRule {
  id: string;
  minEnergy: ClippyEnergy;
  when: {
    app?: string | RegExp;
    windowTitle?: RegExp;
    idleSec?: { min?: number; max?: number };
    downloadsCount?: { min: number };
    screenshotsCount?: { min: number };
    hour?: { min?: number; max?: number };
    custom?: (c: SuggestionContext) => boolean;
  };
  say: string;
  animation: 'GestureUp' | 'GestureLeft' | 'GetAttention' | 'CheckingSomething' | 'Searching' | 'Writing' | 'SendMail' | 'Wave';
  /** If set, the rule can re-arm after this many ms even if already fired. */
  rearmAfterMs?: number;
}

// ═══════════════════════════════════════════════════════════════
// Energy ordering — higher index = higher energy requirement
// ═══════════════════════════════════════════════════════════════

const ENERGY_ORDER: ClippyEnergy[] = ['subtle', 'default', 'lively'];

function energyLevel(e: ClippyEnergy): number {
  return ENERGY_ORDER.indexOf(e);
}

// ═══════════════════════════════════════════════════════════════
// Rule registry — ORDER MATTERS (first match wins)
// ═══════════════════════════════════════════════════════════════

export const RULES: SuggestionRule[] = [
  // ── 1. Mail compose detected ─────────────────────────────────
  // Specific window-title signals (New Message / Re: / Fwd:) come before
  // broad idle rules so this wins over pdf-long-read on email apps.
  // Windows: outlook.exe (new Outlook / M365), olk.exe (new Outlook preview)
  {
    id: 'mail-compose-detected',
    minEnergy: 'subtle',
    when: {
      app: /^(Mail|Outlook|Spark|Airmail|outlook\.exe|olk\.exe)$/,
      windowTitle: /^(New Message|Untitled|Re:|Fwd:)/,
      idleSec: { min: 4, max: 90 },
    },
    say: "Looks like you're writing an email — want me to polish it?",
    animation: 'Writing',
  },

  // ── 2. Slack mention idle ──────────────────────────────────────
  // Mention detection is specific (badge + mention text), put it before
  // broad idle rules.
  // Windows: slack.exe
  {
    id: 'slack-mention-idle',
    minEnergy: 'subtle',
    when: {
      app: /^(Slack|slack\.exe)$/,
      windowTitle: /\(\d+\).*mention|@you/i,
      idleSec: { min: 60 },
    },
    say: "You've got a Slack mention waiting — want me to draft a reply?",
    animation: 'GestureUp',
  },

  // ── 3. VS Code / Cursor error state ───────────────────────────
  // Windows: code.exe (VS Code), cursor.exe (Cursor)
  {
    id: 'vscode-error-state',
    minEnergy: 'default',
    when: {
      app: /^(Code|Cursor|code\.exe|cursor\.exe)$/,
      windowTitle: /●|Problem|Error/,
      idleSec: { min: 8 },
    },
    say: "Looks like there's an error in the editor — want me to take a look?",
    animation: 'GetAttention',
  },

  // ── 4. Notion blank page ──────────────────────────────────────
  // Windows: notion.exe
  {
    id: 'notion-blank-page',
    minEnergy: 'subtle',
    when: {
      app: /^(Notion|notion\.exe)$/,
      windowTitle: /Untitled|New page/i,
      idleSec: { min: 5, max: 60 },
    },
    say: 'Need help getting started on this page?',
    animation: 'Writing',
  },

  // ── 5. PDF long read ──────────────────────────────────────────
  // Windows: AcroRd32.exe (Acrobat Reader DC), Acrobat.exe (Acrobat Pro)
  {
    id: 'pdf-long-read',
    minEnergy: 'default',
    when: {
      app: /^(Preview|Adobe Acrobat|Skim|AcroRd32\.exe|Acrobat\.exe)$/,
      idleSec: { min: 45 },
    },
    say: 'Want me to summarize this PDF for you?',
    animation: 'GestureUp',
  },

  // ── 6. Downloads folder cluttered ────────────────────────────
  {
    id: 'downloads-cluttered',
    minEnergy: 'default',
    when: {
      downloadsCount: { min: 40 },
      idleSec: { min: 30 },
    },
    say: 'Your Downloads folder has {downloadsCount} files — want me to tidy it?',
    animation: 'CheckingSomething',
  },

  // ── 7. Desktop screenshots pileup ────────────────────────────
  {
    id: 'desktop-screenshots-pileup',
    minEnergy: 'default',
    when: {
      screenshotsCount: { min: 20 },
    },
    say: "That's {screenshotsCount} screenshots on your Desktop — want me to file them?",
    animation: 'Searching',
  },

  // ── 8. Morning standup ────────────────────────────────────────
  // Fires once per day (rearmAfterMs = 24h). Lively tier because it's
  // the most proactive / potentially-annoying rule. The custom predicate
  // ensures the user is at their machine (idleSec < 120).
  {
    id: 'morning-standup',
    minEnergy: 'lively',
    when: {
      hour: { min: 8, max: 10 },
      custom: (c) => c.idleSec < 120,
    },
    say: "Morning! Want me to summarize yesterday's tabs and emails?",
    animation: 'Wave',
    rearmAfterMs: 24 * 60 * 60 * 1000, // 24 hours
  },
];

// ═══════════════════════════════════════════════════════════════
// match()
// ═══════════════════════════════════════════════════════════════

export function match(
  ctx: SuggestionContext,
  opts: {
    energy: ClippyEnergy;
    firedThisSession: Set<string>;
    denylist: Set<string>;
    now: number;
    lastFiredAt: Map<string, number>;
  },
): SuggestionRule | null {
  const userEnergyLevel = energyLevel(opts.energy);

  for (const rule of RULES) {
    // 1. Energy gate — skip if the rule requires higher energy than the user's setting
    if (energyLevel(rule.minEnergy) > userEnergyLevel) continue;

    // 2. Denylist gate
    if (opts.denylist.has(rule.id)) continue;

    // 3. Session-fire gate (with optional rearm)
    if (opts.firedThisSession.has(rule.id)) {
      // If no rearm configured, block for the whole session
      if (rule.rearmAfterMs === undefined) continue;
      // If rearm configured, check if enough time has passed
      const lastFired = opts.lastFiredAt.get(rule.id);
      if (lastFired !== undefined && opts.now - lastFired < rule.rearmAfterMs) continue;
    }

    // 4. Evaluate all when-clauses
    const w = rule.when;

    if (w.app !== undefined) {
      if (typeof w.app === 'string') {
        if (ctx.app !== w.app) continue;
      } else {
        // RegExp
        if (!w.app.test(ctx.app)) continue;
      }
    }

    if (w.windowTitle !== undefined) {
      if (!w.windowTitle.test(ctx.windowTitle)) continue;
    }

    if (w.idleSec !== undefined) {
      const { min, max } = w.idleSec;
      if (min !== undefined && ctx.idleSec < min) continue;
      if (max !== undefined && ctx.idleSec > max) continue;
    }

    if (w.downloadsCount !== undefined) {
      if (ctx.downloadsCount === undefined || ctx.downloadsCount < w.downloadsCount.min) continue;
    }

    if (w.screenshotsCount !== undefined) {
      if (ctx.screenshotsCount === undefined || ctx.screenshotsCount < w.screenshotsCount.min) continue;
    }

    if (w.hour !== undefined) {
      const { min, max } = w.hour;
      if (min !== undefined && ctx.hourOfDay < min) continue;
      if (max !== undefined && ctx.hourOfDay > max) continue;
    }

    if (w.custom !== undefined) {
      if (!w.custom(ctx)) continue;
    }

    // All clauses passed — return this rule
    return rule;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// interpolate()
// ═══════════════════════════════════════════════════════════════

/**
 * Simple template substitution.
 * Replaces {downloadsCount}, {screenshotsCount}, {idleSec}, {hourOfDay},
 * {app}, {windowTitle} with the corresponding ctx values.
 * Unknown variables → empty string.
 */
export function interpolate(template: string, ctx: SuggestionContext): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    switch (key) {
      case 'downloadsCount':   return ctx.downloadsCount?.toString() ?? '?';
      case 'screenshotsCount': return ctx.screenshotsCount?.toString() ?? '?';
      case 'idleSec':          return ctx.idleSec.toString();
      case 'hourOfDay':        return ctx.hourOfDay.toString();
      case 'app':              return ctx.app;
      case 'windowTitle':      return ctx.windowTitle;
      default:                 return '';
    }
  });
}
