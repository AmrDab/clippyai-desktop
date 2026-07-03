/**
 * v0.19.0 PR-6 — app catalog for the onboarding step-4 picker AND the
 * Settings → Apps mirror. Single source of truth for IDs, labels, group
 * assignments, and inline SVG icons.
 *
 * Why inline SVGs (not <img src> to PNGs):
 *   - Zero external requests at render time. The onboarding window
 *     ships with CSP `default-src 'self'` and the icons must render
 *     without unblocking remote hosts.
 *   - No new bundled assets folder → no electron-builder.yml churn.
 *   - The Liquid Glass tint is easy to apply via CSS color/filter on
 *     the parent — we use currentColor where possible.
 *
 * IMPORTANT: Every `id` here MUST also appear in KNOWN_APP_IDS in
 * src/main/license.ts. The IPC clamp in ipc.ts rejects unknown IDs;
 * a mismatch would silently drop user selections.
 */

export interface AppCatalogEntry {
  id: string;
  name: string;
  /** True if this app has a v0.20+ API path; only these surface in step 5. */
  hasApi: boolean;
  /** Inline SVG markup (no <?xml?> wrapper). Sized via parent CSS. */
  iconSvg: string;
  /** Description for the "How to get this" disclosure in step 5. Only
   *  meaningful for hasApi: true entries. */
  apiInstructions?: string;
}

export interface AppGroup {
  id: string;
  label: string;
  apps: AppCatalogEntry[];
}

/* SVG icons — minimal abstract glyphs. Each ~24×24, currentColor stroke
 * with a subtle tinted fill so they read on the glass background without
 * having to embed brand logos (avoids trademark mess + keeps the visual
 * unified). */
function glyph(d: string, fill: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="6" fill="${fill}" opacity="0.18"/>
    <path d="${d}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/* Email — envelope */
const ICON_EMAIL = glyph('M5 8.5l7 4.5 7-4.5M5 8.5V17a1 1 0 001 1h12a1 1 0 001-1V8.5M5 8.5L11 5.5a2 2 0 012 0l6 3', '#ea4335');
/* Gmail — envelope w/ M */
const ICON_GMAIL = glyph('M5 7v10h2.5V11l4.5 3.5L16.5 11v6H19V7l-7 5-7-5z', '#ea4335');
/* Outlook — squared envelope */
const ICON_OUTLOOK = glyph('M5 7h14v10H5zM5 7l7 5 7-5M8 12a2 2 0 104 0 2 2 0 00-4 0z', '#0078d4');

/* Calendar — generic */
const ICON_CAL_APPLE = glyph('M6 5h12a1 1 0 011 1v13a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1zM5 9h14M8 5V3M16 5V3', '#fa3232');
const ICON_CAL_GOOGLE = glyph('M6 5h12a1 1 0 011 1v13a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1zM5 9h14M10 13h4M10 17h4', '#1a73e8');
const ICON_CAL_OUTLOOK = glyph('M6 5h12a1 1 0 011 1v13a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1zM5 9h14M8 5V3M16 5V3M9 13l2 2 4-4', '#0078d4');

/* Notes */
const ICON_NOTION = glyph('M6 5h12v14H6zM9 8h6M9 12h6M9 16h4', '#000000');
const ICON_OBSIDIAN = glyph('M12 4l6 4-2 11H8L6 8l6-4zM10 18l2-10 2 10', '#7c3aed');
const ICON_APPLE_NOTES = glyph('M7 4h7l4 4v12a1 1 0 01-1 1H7a1 1 0 01-1-1V5a1 1 0 011-1zM14 4v4h4M9 13h6M9 17h6', '#f7c948');

/* Messaging */
const ICON_SLACK = glyph('M9 6a2 2 0 114 0v8a2 2 0 11-4 0V6zM6 9a2 2 0 110 4h8a2 2 0 110-4H6z', '#4a154b');
const ICON_TEAMS = glyph('M5 7h10v10H5zM15 9h4v6h-4M8 10h4M10 10v4', '#6264a7');

/* CRM */
const ICON_HUBSPOT = glyph('M12 4v6m0 0a4 4 0 100 8 4 4 0 000-8zM12 4a2 2 0 110-4 2 2 0 010 4z', '#ff7a59');
const ICON_SALESFORCE = glyph('M7 14a3 3 0 014-2.8A4 4 0 0117 12a3 3 0 010 6H8a3 3 0 01-1-4z', '#00a1e0');

/* Dev */
const ICON_GITHUB = glyph('M12 4a8 8 0 00-2.5 15.6c.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.4.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 014 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2.1 0 3.1-1.8 3.7-3.6 4 .3.3.5.7.5 1.4v2.1c0 .2.1.5.5.4A8 8 0 0012 4z', '#171515');
const ICON_LINEAR = glyph('M4 12L12 4l8 8-8 8-8-8zM7 12l5-5M12 17l5-5', '#5e6ad2');
const ICON_JIRA = glyph('M5 12l7 7 7-7-7-7-7 7zM9 12l3 3 3-3-3-3-3 3z', '#0052cc');

/* Browser */
const ICON_CHROME = glyph('M12 4a8 8 0 00-7 4.6h7a4 4 0 014 4M5 8.6l4 4M12 20a8 8 0 008-7.4l-4-4M12 20l-3.5-6.4M16 12.6a4 4 0 11-8 0 4 4 0 018 0z', '#4285f4');
const ICON_SAFARI = glyph('M12 4a8 8 0 100 16 8 8 0 000-16zM12 4v3M12 17v3M4 12h3M17 12h3M14.8 9.2l-2.8 2.8M11.4 12.6L9.2 14.8M14.8 14.8L11.4 11.4M9.2 9.2L12 12', '#1e88e5');
const ICON_ARC = glyph('M5 18a8 8 0 0114-10M9 18a6 6 0 0110-4M13 18a4 4 0 016-2', '#ff6f47');

const EMAIL_INSTRUCTIONS_GMAIL = 'Gmail → click your avatar → Manage your Google Account → Security → 2-Step Verification → App passwords. Create one for "Mail" and paste it here. (We do NOT keep your main password; the app password is revocable from the same screen.)';

const HUBSPOT_INSTRUCTIONS = 'HubSpot → Settings (gear icon, top-right) → Integrations → Private Apps → Create a private app. Give it scopes for the objects you want Clippy to touch (contacts, deals, notes), then copy the access token.';

const NOTION_INSTRUCTIONS = 'Notion → Settings & Members → My Connections → Develop or manage integrations → "+ New integration". Pick "Internal" type, give it read/write capabilities, copy the "Internal Integration Secret". You also need to share each page/database with the integration from its share menu.';

const SLACK_INSTRUCTIONS = 'api.slack.com/apps → Create New App → From scratch → name it "Clippy" → install to your workspace. Under OAuth & Permissions, copy the "User OAuth Token" (starts with xoxp-). Bot tokens (xoxb-) also work if you want a bot-style account.';

const LINEAR_INSTRUCTIONS = 'Linear → click your avatar → Preferences → API → Personal API keys → Create key. Copy the key (starts with lin_api_) and paste here. Scope is "all teams" by default; you can scope down later.';

const GITHUB_INSTRUCTIONS = 'GitHub → profile → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Pick the repos Clippy should access and grant "Issues: Read & write" + "Contents: Read". Copy the ghp_ / github_pat_ token.';

export const APP_CATALOG: AppGroup[] = [
  {
    id: 'email',
    label: 'Email',
    apps: [
      { id: 'apple-mail', name: 'Apple Mail', hasApi: false, iconSvg: ICON_EMAIL },
      { id: 'gmail', name: 'Gmail', hasApi: true, iconSvg: ICON_GMAIL, apiInstructions: EMAIL_INSTRUCTIONS_GMAIL },
      { id: 'outlook', name: 'Outlook', hasApi: false, iconSvg: ICON_OUTLOOK },
    ],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    apps: [
      { id: 'apple-calendar', name: 'Apple Calendar', hasApi: false, iconSvg: ICON_CAL_APPLE },
      { id: 'google-calendar', name: 'Google Calendar', hasApi: false, iconSvg: ICON_CAL_GOOGLE },
      { id: 'outlook-calendar', name: 'Outlook Calendar', hasApi: false, iconSvg: ICON_CAL_OUTLOOK },
    ],
  },
  {
    id: 'notes',
    label: 'Notes',
    apps: [
      { id: 'notion', name: 'Notion', hasApi: true, iconSvg: ICON_NOTION, apiInstructions: NOTION_INSTRUCTIONS },
      { id: 'obsidian', name: 'Obsidian', hasApi: false, iconSvg: ICON_OBSIDIAN },
      { id: 'apple-notes', name: 'Apple Notes', hasApi: false, iconSvg: ICON_APPLE_NOTES },
    ],
  },
  {
    id: 'messaging',
    label: 'Messaging',
    apps: [
      { id: 'slack', name: 'Slack', hasApi: true, iconSvg: ICON_SLACK, apiInstructions: SLACK_INSTRUCTIONS },
      { id: 'teams', name: 'Microsoft Teams', hasApi: false, iconSvg: ICON_TEAMS },
    ],
  },
  {
    id: 'crm',
    label: 'CRM',
    apps: [
      { id: 'hubspot', name: 'HubSpot', hasApi: true, iconSvg: ICON_HUBSPOT, apiInstructions: HUBSPOT_INSTRUCTIONS },
      { id: 'salesforce', name: 'Salesforce', hasApi: false, iconSvg: ICON_SALESFORCE },
    ],
  },
  {
    id: 'dev',
    label: 'Dev',
    apps: [
      { id: 'github', name: 'GitHub', hasApi: true, iconSvg: ICON_GITHUB, apiInstructions: GITHUB_INSTRUCTIONS },
      { id: 'linear', name: 'Linear', hasApi: true, iconSvg: ICON_LINEAR, apiInstructions: LINEAR_INSTRUCTIONS },
      { id: 'jira', name: 'Jira', hasApi: false, iconSvg: ICON_JIRA },
    ],
  },
  {
    id: 'browser',
    label: 'Browser',
    apps: [
      { id: 'chrome', name: 'Chrome', hasApi: false, iconSvg: ICON_CHROME },
      { id: 'safari', name: 'Safari', hasApi: false, iconSvg: ICON_SAFARI },
      { id: 'arc', name: 'Arc', hasApi: false, iconSvg: ICON_ARC },
    ],
  },
];

/** Flat lookup for IPC validation + Settings rendering. */
export const APP_BY_ID: Record<string, AppCatalogEntry> = (() => {
  const out: Record<string, AppCatalogEntry> = {};
  for (const group of APP_CATALOG) {
    for (const app of group.apps) {
      out[app.id] = app;
    }
  }
  return out;
})();

/** v0.19.0 PR-6 — the 5 chips wired on step 6 + the post-onboarding overlay. */
export const FIRST_WINS: { label: string; prompt: string }[] = [
  { label: 'Summarize this screen', prompt: 'Summarize what I have on my screen right now.' },
  { label: 'Clean my desktop', prompt: 'Help me clean and organize my desktop.' },
  { label: 'Draft a reply to my last email', prompt: 'Draft a reply to my last email.' },
  { label: 'Find that file I worked on last week', prompt: 'Find the file I was working on last week.' },
  { label: 'Block 90 minutes for deep work tomorrow', prompt: 'Block 90 minutes for deep work tomorrow.' },
];
