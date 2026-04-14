# ClippyAI Developer Guide

Everything a developer needs to work on ClippyAI. No secrets in this file — all credentials are retrieved from their source of truth.

## Architecture

```
User Desktop                          Cloud
┌─────────────────┐                  ┌──────────────────────────┐
│ ClippyAI.exe    │   HTTPS          │ api.clippyai.app         │
│ (Electron)      │──────────────────│ (Cloudflare Worker)      │
│                 │                  │                          │
│ ├─ brain.ts     │  /chat           │ ├─ Gemini 2.5 Pro/Flash  │
│ ├─ tools.ts     │  /agent          │ ├─ Supabase (Postgres)   │
│ ├─ updater.ts   │  /validate       │ ├─ Stripe (billing)      │
│ └─ PowerShell   │  /report         │ ├─ Resend (email)        │
│    UIA scripts  │                  │ └─ Cloudflare KV (logs)  │
└─────────────────┘                  └──────────────────────────┘

clippyai.app (Cloudflare Pages) — marketing site
download.clippyai.app (Cloudflare R2) — installer hosting
```

## Repos

| Repo | Purpose | Location |
|------|---------|----------|
| `clippyai-desktop` | Electron desktop app | `C:\Users\amr_d\ClippyAI` / github.com/AmrDab/clippyai-desktop |
| `clippyai-api` | Backend Cloudflare Worker | `C:\Users\amr_d\clippyai-api` / github.com/AmrDab/clippyai-api |
| `clippyai-web` | Marketing site | `C:\Users\amr_d\clippyai-web` / github.com/AmrDab/clippyai-web |

## Local Dev Setup

### Desktop App
```bash
cd C:\Users\amr_d\ClippyAI
npm install
npm run dev          # Run in dev mode (hot reload)
npm run build        # Build for production
npm run dist         # Build + create installer
```

### Backend API
```bash
cd C:\Users\amr_d\clippyai-api
npm install
npx wrangler dev     # Local dev server at localhost:8787
npx wrangler deploy  # Deploy to production
```

### Website
```bash
cd C:\Users\amr_d\clippyai-web
npx wrangler pages deploy . --project-name=clippyai --branch=main
```

## Release Process

```bash
# 1. Bump version in package.json
# 2. Build installer
npm run dist

# 3. Create GitHub Release (auto-updater reads this)
gh release create v0.X.Y release/ClippyAI-Setup-0.X.Y.exe release/ClippyAI-Setup-0.X.Y.exe.blockmap release/latest.yml --title "v0.X.Y" --notes "..."

# 4. Upload to R2 for website download
cd ../clippyai-web && npx wrangler r2 object put clippyai-downloads/ClippyAI-Setup-latest.exe --file=../ClippyAI/release/ClippyAI-Setup-0.X.Y.exe --content-type=application/x-msdownload --remote

# 5. Also upload with versioned name (cache-bust)
npx wrangler r2 object put clippyai-downloads/ClippyAI-Setup.exe --file=../ClippyAI/release/ClippyAI-Setup-0.X.Y.exe --content-type=application/x-msdownload --remote
```

## Credential Locations

**NEVER put secrets in code, docs, or commits. Retrieve from the source.**

### Cloudflare Worker Secrets (`clippyai-api`)
```bash
npx wrangler secret list                    # See what's set
npx wrangler secret put STRIPE_SECRET_KEY   # Set a secret (prompts for value)
```

| Secret | Source | How to get |
|--------|--------|-----------|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys → Secret key (Live mode) | |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → destination → Signing secret | |
| `RESEND_API_KEY` | resend.com → API Keys | |
| `SUPABASE_URL` | Supabase → Project Settings → API → URL | |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role key | |
| `OPENAI_API_KEY` | platform.openai.com → API keys | |
| `GEMINI_API_KEY` | aistudio.google.com → Get API key | |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | |

### Cloudflare KV
- Namespace: `LOG_REPORTS` (ID in `wrangler.toml`)
- Used for user-submitted log reports (30-day TTL)

### GitHub
```bash
gh auth login   # Authenticate GitHub CLI
```
Repo: `AmrDab/clippyai-desktop` (public — needed for auto-updater)

## Admin Endpoints

### View user log reports
```bash
curl -s "https://api.clippyai.app/admin/reports" \
  -H "Authorization: Bearer <STRIPE_WEBHOOK_SECRET>"
```

### Provision a license key manually
```bash
curl -s -X POST "https://api.clippyai.app/admin/provision" \
  -H "Authorization: Bearer <STRIPE_WEBHOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

### Check user's subscription
```bash
curl -s -X POST "https://api.clippyai.app/validate" \
  -H "Content-Type: application/json" \
  -d '{"key":"CLIPPY-XXXX-XXXX-XXXX"}'
```

### Stripe Customer Portal (for a user)
```
https://api.clippyai.app/portal?key=CLIPPY-XXXX-XXXX-XXXX
```

## Supabase

- **Dashboard:** https://supabase.com/dashboard/project/prpkgecogrjigiwdbbsq
- **Login:** amraldabbas19@gmail.com
- **Tables:**
  - `users` — email, stripe_customer_id
  - `subscriptions` — license_key, plan, status, tokens_used, tokens_allowed, stripe_sub_id
  - `log_reports` — license_key, logs, version, created_at

### Useful queries (SQL Editor)
```sql
-- Find a user by email
SELECT * FROM subscriptions s
JOIN users u ON s.user_id = u.id
WHERE u.email = 'user@example.com';

-- Check token usage
SELECT license_key, plan, tokens_used, tokens_allowed,
       ROUND(100.0 * tokens_used / tokens_allowed, 1) AS pct_used
FROM subscriptions WHERE status = 'active';

-- Reset tokens for a user
UPDATE subscriptions SET tokens_used = 0 WHERE license_key = 'CLIPPY-XXXX-XXXX-XXXX';
```

## Stripe

- **Dashboard:** https://dashboard.stripe.com
- **Login:** amraldabbas19@gmail.com
- **Products:** Basic ($4.99), Pro ($9.99), Power ($19.99)
- **Payment Links:**
  - Basic: `https://buy.stripe.com/dRmfZg9w9dtY2LrgaWe3e01`
  - Pro: `https://buy.stripe.com/7sY6oGaAd2Pk71H2k6e3e02`
  - Power: `https://buy.stripe.com/4gMbJ0dMp9dI3Pve2Oe3e00`
- **Webhook:** `https://api.clippyai.app/webhooks/stripe` (destination: charismatic-harmony)
- **Events listened:** checkout.session.completed, customer.subscription.created/updated/deleted, invoice.payment_succeeded/failed

## Resend (Email)

- **Dashboard:** https://resend.com
- **Login:** amraldabbas19@gmail.com
- **Domain:** clippyai.app (verified, DKIM + SPF configured)
- **From address:** `Clippy <hello@clippyai.app>`
- **Templates in code:** `src/lib/email.ts` — licenseKeyEmail(), subscriptionCancelledEmail()

## Cloudflare

- **Dashboard:** https://dash.cloudflare.com
- **Login:** amraldabbas19@gmail.com
- **Zone:** clippyai.app
- **Pages project:** `clippyai` (serves clippyai.app, branch: main)
- **Worker:** `clippyai-api` (serves api.clippyai.app)
- **R2 bucket:** `clippyai-downloads` (serves download.clippyai.app)
- **Email Routing:** hello@clippyai.app → amraldabbas19@gmail.com
- **KV namespace:** LOG_REPORTS

## Desktop App Structure

```
src/main/
  index.ts        — App entry, startup, single-instance lock
  brain.ts        — AI logic, message classification, agent loop
  tools.ts        — Direct tool execution (PowerShell, no server)
  ipc.ts          — IPC handlers (message, settings, update, report)
  license.ts      — License validation, grace period
  updater.ts      — Auto-update via GitHub Releases
  logger.ts       — File logging with rotation
  window.ts       — Window management (main, settings, onboarding, logs)
  tray.ts         — System tray icon and menu

src/renderer/
  main.ts         — Clippy animation controller, bubble, TTS
  onboarding.ts   — License key entry, trial button
  settings.ts     — Settings page logic
  logs.html       — Log viewer (dark theme, color-coded)
  clippy.ts       — Sprite animation engine
  bubble.ts       — Chat bubble UI

src/preload/
  index.ts        — IPC bridge (window.clippy API)

assets/brain/     — AI guidance files (bundled via extraResources)
  identity.md     — Who Clippy is
  core-behavior.md — Rules
  tool-guide.md   — Available tools and response format
  app-knowledge.md — App-specific tips
  safety-rules.md — Safety rules

assets/scripts/   — PowerShell scripts (bundled via extraResources)
  ps-bridge.ps1   — Persistent UIA bridge
  get-screen-context.ps1 — Read accessibility tree
  focus-window.ps1 — Bring window to front
  find-element.ps1 — UIA element search
  etc.
```

## Backend API Structure

```
src/
  index.ts         — Router, CORS, error handling
  routes/
    chat.ts        — /chat endpoint (Gemini chat)
    agent.ts       — /agent endpoint (Gemini agent loop)
    webhook.ts     — /webhooks/stripe (subscription lifecycle)
    admin.ts       — /admin/provision (manual license creation)
  lib/
    gemini.ts      — Gemini API wrapper with fallback chain
    license.ts     — Plan tokens, model routing
    supabase.ts    — Database operations
    email.ts       — Email templates via Resend
    quota.ts       — Token quota enforcement
```

## AI Model Routing

| Plan | Model | Tokens/month |
|------|-------|-------------|
| Basic | gemini-2.5-flash-lite | 500,000 |
| Pro | gemini-2.5-flash | 2,000,000 |
| Power | gemini-2.5-pro | 5,000,000 |

Fallback chain (all endpoints): Primary → gemini-2.5-flash → gemini-2.0-flash → gemini-1.5-flash

## Troubleshooting

### "Brain hiccup! Try again."
All Gemini models returned 503. Google outage. Wait and retry. Check: https://status.cloud.google.com

### "Clippy not responding to questions"
Check `this.win` references in brain.ts — a `this.mainWindow` typo crashes silently.

### ClippyAI shows as "Electron" with Electron icon
`afterPack` hook in `scripts/after-pack.js` runs rcedit to embed icon. If `signAndEditExecutable: false` is set AND afterPack is disabled, the exe ships with default Electron branding.

### Customer can't install (NSIS integrity error)
Usually antivirus modifying the exe after download. Have them try:
1. Disable AV temporarily
2. Download in Chrome incognito
3. Verify file size matches what R2 serves

### Auto-update fails with "not signed by publisher"
`publisherName` was removed from electron-builder.yml. If an old build still has it, the updater rejects unsigned updates. Customer must re-download manually.

### PSBridge timeout (12s)
PowerShell UIA bridge is slow on some machines. Non-fatal — tools still work via one-off PowerShell calls.

### License key not received after purchase
1. Check Stripe webhook deliveries (Developers → Webhooks → Event deliveries)
2. Check Resend dashboard for email delivery
3. Manual provision: `POST /admin/provision {"email":"..."}`

### View user logs remotely
```bash
curl -s "https://api.clippyai.app/admin/reports" -H "Authorization: Bearer <STRIPE_WEBHOOK_SECRET>"
```

## Contact

- **Support inbox:** hello@clippyai.app (routed to amraldabbas19@gmail.com)
- **Owner:** Amr Dabbas / Cloudana
