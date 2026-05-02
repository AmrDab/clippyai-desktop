# ClippyAI — Ops Runbook

Everything you need to operate, monitor, and control ClippyAI as its owner.
Last updated: 2026-05-02

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Admin API](#2-admin-api)
3. [License Keys](#3-license-keys)
4. [Supabase — Users & Subscriptions](#4-supabase--users--subscriptions)
5. [Stripe — Billing](#5-stripe--billing)
6. [Resend — Email](#6-resend--email)
7. [Cloudflare — Worker, KV, R2](#7-cloudflare--worker-kv-r2)
8. [Log Reports](#8-log-reports)
9. [Releasing a New Version](#9-releasing-a-new-version)
10. [Secrets Reference](#10-secrets-reference)
11. [Plans & Token Budgets](#11-plans--token-budgets)

---

## 1. System Overview

| Layer | Service | URL / Location |
|---|---|---|
| Desktop app | Electron (Windows) | `C:\Users\amr_d\ClippyAI` |
| API backend | Cloudflare Worker | `https://clippyai-api.amraldabbas19.workers.dev` |
| Database | Supabase (Postgres) | https://supabase.com → ClippyAI project |
| Billing | Stripe | https://dashboard.stripe.com |
| Email | Resend | https://resend.com |
| Installer CDN | Cloudflare R2 | `clippyai-downloads` bucket → `download.clippyai.app` |
| Auto-update source | GitHub Releases | https://github.com/AmrDab/clippyai-desktop/releases |
| Landing page | Static site | `C:\Users\amr_d\clippyai-web` |

**AI backend:** Kimi K2 (Moonshot) via `AI_PROVIDER=kimi` env var. Fallback: Gemini 2.5 Flash.

---

## 2. Admin API

All admin endpoints live on the Worker. Auth header is the same for all:

```
Authorization: Bearer <ADMIN_API_KEY>
```

The `ADMIN_API_KEY` is stored as a Cloudflare Worker secret (write-only — not visible in the dashboard). The current value is known only at secret-set time. If lost, rotate it via the Cloudflare REST API (see §10).

---

### POST /admin/provision

Manually provision a license key for a Stripe subscriber (use when a webhook was missed).

```bash
curl -X POST https://clippyai-api.amraldabbas19.workers.dev/admin/provision \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "subscriptionId": "sub_xxx" }'

# Or look up by email:
curl -X POST .../admin/provision \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "email": "customer@example.com" }'
```

**Response:**
```json
{
  "ok": true,
  "email": "customer@example.com",
  "plan": "power",
  "licenseKey": "CLIPPY-XXXX-XXXX-XXXX",
  "emailSent": true,
  "emailError": null
}
```

Idempotent — safe to retry. Re-uses the existing key if one was already generated for that Stripe sub.

---

### POST /admin/promo

Give someone free access (no Stripe required). Generates a key, inserts it into Supabase, and emails it to the recipient.

```bash
curl -X POST https://clippyai-api.amraldabbas19.workers.dev/admin/promo \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "friend@example.com",
    "plan": "power",
    "months": 12
  }'
```

| Field | Default | Notes |
|---|---|---|
| `email` | required | Recipient |
| `plan` | `"power"` | `"basic"` / `"pro"` / `"power"` |
| `months` | `12` | How long until `reset_date` (token quota resets) |

**Response:** same shape as `/admin/provision`.

---

### GET /admin/reports

Fetch the 20 most recent user log reports.

```bash
curl https://clippyai-api.amraldabbas19.workers.dev/admin/reports \
  -H "Authorization: Bearer <ADMIN_API_KEY>"
```

**Response:** array of report objects:
```json
[
  {
    "id": "uuid",
    "license_key": "CLIPPY-XXXX-XXXX-XXXX",
    "logs": "...(up to 50,000 chars)...",
    "description": "user's description of the issue",
    "version": "0.11.15",
    "created_at": "2026-05-01T12:00:00.000Z"
  }
]
```

Reports are stored in Cloudflare KV (`LOG_REPORTS` binding) with a 30-day TTL.

---

### GET /health

```bash
curl https://clippyai-api.amraldabbas19.workers.dev/health
```

Returns `{ status: "ok", version: "0.1.0", serverDate: "..." }`. Use to confirm the Worker is up.

---

## 3. License Keys

**Format:** `CLIPPY-XXXX-XXXX-XXXX` (Crockford base32, no I/L/O/U to avoid visual ambiguity)

**Test key:** `CLIPPY-TEST-AMRD-2026` (hardcoded bypass — always validates, never deducted from quota)

**How keys work:**
1. Customer pays on Stripe → webhook fires → Worker creates Supabase row + emails key
2. Customer opens Clippy → enters key in Settings → app calls `POST /validate` → gets plan + token quota
3. Each AI turn deducts tokens from `tokens_used`; resets on `reset_date`

**To look up a key manually:** Supabase → Table Editor → `subscriptions` → filter `license_key = 'CLIPPY-...'`

**To revoke a key:** Supabase → set `status = 'cancelled'` on that row. The app will get a `subscription_cancelled` error on next validate.

---

## 4. Supabase — Users & Subscriptions

**Dashboard:** https://supabase.com → sign in → ClippyAI project

### Tables

**`users`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `email` | text | unique |
| `stripe_customer_id` | text | nullable (promo users have none) |
| `created_at` | timestamptz | |

**`subscriptions`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | FK → users |
| `license_key` | text | `CLIPPY-XXXX-XXXX-XXXX` |
| `plan` | text | `basic` / `pro` / `power` |
| `status` | text | `active` / `cancelled` / `past_due` |
| `tokens_allowed` | int | budget for the period |
| `tokens_used` | int | incremented per turn |
| `reset_date` | timestamptz | when tokens_used resets to 0 |
| `stripe_sub_id` | text | nullable for promo subscriptions |

### Common queries (Table Editor or SQL Editor)

```sql
-- All active subscriptions
SELECT u.email, s.plan, s.license_key, s.tokens_used, s.tokens_allowed, s.reset_date
FROM subscriptions s
JOIN users u ON u.id = s.user_id
WHERE s.status = 'active'
ORDER BY s.reset_date DESC;

-- Heavy users (used > 80% of quota)
SELECT u.email, s.plan, s.tokens_used, s.tokens_allowed,
       round(s.tokens_used::numeric / s.tokens_allowed * 100) as pct_used
FROM subscriptions s
JOIN users u ON u.id = s.user_id
WHERE s.status = 'active'
  AND s.tokens_used > s.tokens_allowed * 0.8;

-- Find a specific user
SELECT * FROM subscriptions WHERE license_key = 'CLIPPY-XXXX-XXXX-XXXX';
SELECT * FROM subscriptions WHERE stripe_sub_id = 'sub_xxx';

-- Reset a user's token counter manually
UPDATE subscriptions SET tokens_used = 0 WHERE license_key = 'CLIPPY-XXXX-XXXX-XXXX';

-- Revoke a key
UPDATE subscriptions SET status = 'cancelled' WHERE license_key = 'CLIPPY-XXXX-XXXX-XXXX';
```

### RPC function

`increment_tokens_used(sub_id uuid, amount int)` — atomic increment used by the Worker after each AI turn. Defined in Supabase → Database → Functions.

---

## 5. Stripe — Billing

**Dashboard:** https://dashboard.stripe.com

### Key objects

| Object | Where to find |
|---|---|
| Customers | Customers tab → search by email |
| Subscriptions | Subscriptions tab |
| Payment Links | Payment Links tab |
| Webhooks | Developers → Webhooks |

### Webhook endpoint

```
https://clippyai-api.amraldabbas19.workers.dev/webhooks/stripe
```

**Events handled:**
- `checkout.session.completed` → provisions license key + sends email
- `customer.subscription.deleted` → sets status = `cancelled`
- `customer.subscription.updated` → updates plan / tokens_allowed
- `invoice.payment_succeeded` → resets `tokens_used = 0`, advances `reset_date`

**If a webhook was missed:** use `POST /admin/provision` with the Stripe subscription ID to manually backfill.

### Price → Plan mapping

Hardcoded in `src/routes/admin.ts`:
```
price_1TJY16CMmq8Ko4WnUKepR49p → power
```
Add basic/pro price IDs to `PRICE_TO_PLAN` when Payment Links are wired up.

### Customer Portal

Customers can manage their own subscription (cancel, update card, view invoices) via:
```
POST https://clippyai-api.amraldabbas19.workers.dev/portal
Authorization: Bearer <license_key>
```
Returns `{ url: "https://billing.stripe.com/..." }` — the app opens it in the browser.

---

## 6. Resend — Email

**Dashboard:** https://resend.com (log in with `amraldabbas19@gmail.com` via Google)

**Sending domain:** `clippyai.app` (DNS records verified)
**From address:** `hello@clippyai.app`
**Free tier:** 3,000 emails/month

### What triggers emails

| Trigger | Template |
|---|---|
| New subscription provisioned | "Your ClippyAI license key is here!" |
| Subscription cancelled | "Sorry to see you go!" |
| Admin promo granted | Same as new subscription |

### Viewing sent emails

Resend dashboard → **Emails** tab → filter by date / status / recipient.

Status can be: `Delivered`, `Bounced`, `Complained`, `Clicked`, `Opened`.

### Resending a key manually

Use `POST /admin/provision` with the customer's email or Stripe sub ID — it will re-send the email (and reuse the existing key).

### API key

Stored as Cloudflare Worker secret `RESEND_API_KEY`. Not visible once set. Rotate via Resend dashboard → API Keys → create new → update the Worker secret.

---

## 7. Cloudflare — Worker, KV, R2

**Dashboard:** https://dash.cloudflare.com → account `amraldabbas19@gmail.com`
**Account ID:** `001b9c277681a237d32b6a1413e101d4`

### Worker

**Name:** `clippyai-api`
**URL:** `https://clippyai-api.amraldabbas19.workers.dev`

**Deploy:**
```powershell
cd C:\Users\amr_d\clippyai-api
npx wrangler@latest deploy
```

**View live logs:**
```powershell
npx wrangler@latest tail
```

**Worker secrets** (set via Cloudflare REST API — no trailing newline issue):
```powershell
$secret = "your-secret-value"
$headers = @{ "Authorization" = "Bearer <CF_API_TOKEN>"; "Content-Type" = "application/json" }
$body = @{ name = "SECRET_NAME"; text = $secret; type = "secret_text" } | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/001b9c277681a237d32b6a1413e101d4/workers/scripts/clippyai-api/secrets" -Method Put -Headers $headers -Body $body
```

> ⚠️ Do NOT use `echo $value | wrangler secret put` — the pipe adds a trailing newline which breaks timing-safe auth comparisons.

### KV — Log Reports

**Namespace:** `LOG_REPORTS`

View in dashboard: Workers & Pages → KV → `LOG_REPORTS` → keys prefixed `report:`.

Each key TTL is 30 days. Max 20 returned per `/admin/reports` call.

### R2 — Installer Downloads

**Bucket:** `clippyai-downloads`
**Public URL:** `https://download.clippyai.app/ClippyAI-Setup-latest.exe`

Upload a new installer:
```powershell
npx --yes wrangler@latest r2 object put clippyai-downloads/ClippyAI-Setup-latest.exe `
  --file C:\Users\amr_d\ClippyAI\release\ClippyAI-Setup-X.Y.Z.exe `
  --remote
```

> ⚠️ `--remote` is required. Without it, wrangler writes to local miniflare state silently.

---

## 8. Log Reports

Users submit log reports from inside Clippy (Help → Report a Problem).

**Storage:** Cloudflare KV (`LOG_REPORTS`), 30-day TTL
**View via API:** `GET /admin/reports` (returns 20 most recent)
**View raw:** Cloudflare dashboard → Workers & Pages → KV → `LOG_REPORTS`

**Log file on user's machine:** `%USERPROFILE%\.clippyai\logs\clippy-YYYY-MM-DD.log`

Each report contains:
- `license_key` — identifies who submitted it
- `logs` — raw app logs (up to 50,000 chars)
- `description` — user's description of the issue
- `version` — Clippy version they were running
- `created_at` — ISO timestamp

Rate limited: 5 reports per IP per minute to prevent KV flooding.

---

## 9. Releasing a New Version

Both steps are required. Skipping either means new users get the old installer OR existing users never auto-update.

### Step 1 — Build

```powershell
cd C:\Users\amr_d\ClippyAI

# Bump version in BOTH files (must match):
# - package.json → "version": "X.Y.Z"
# - electron-builder.yml → buildVersion: X.Y.Z

npm run dist
# Output in release/ :
#   ClippyAI-Setup-X.Y.Z.exe
#   ClippyAI-Setup-X.Y.Z.exe.blockmap
#   latest.yml
```

### Step 2 — GitHub Release (auto-update source)

All 3 files must be attached — missing any one silently breaks auto-update.

```powershell
# Get stored GitHub PAT from Windows Credential Manager
$token = ("protocol=https`nhost=github.com`n" | git credential-manager get | Select-String '^password=').Line.Substring(9)

# Create release
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/AmrDab/clippyai-desktop/releases" `
  -Method Post -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body (@{ tag_name = "vX.Y.Z"; name = "vX.Y.Z"; body = "Release notes here"; draft = $false; prerelease = $false } | ConvertTo-Json)

# Upload each of the 3 assets to $release.upload_url
```

### Step 3 — R2 Upload (new user installer source)

```powershell
npx --yes wrangler@latest r2 object put clippyai-downloads/ClippyAI-Setup-latest.exe `
  --file C:\Users\amr_d\ClippyAI\release\ClippyAI-Setup-X.Y.Z.exe `
  --remote
```

### Step 4 — Verify

```powershell
# GitHub assets present
curl -sL "https://api.github.com/repos/AmrDab/clippyai-desktop/releases/tags/vX.Y.Z"

# R2 updated (check Content-Length and Last-Modified)
curl -sI "https://download.clippyai.app/ClippyAI-Setup-latest.exe"
```

### Deploy API changes

```powershell
cd C:\Users\amr_d\clippyai-api
npx wrangler@latest deploy
```

---

## 10. Secrets Reference

All secrets live as Cloudflare Worker secrets (write-only after setting — not visible in dashboard).

| Secret name | What it is | Where to rotate |
|---|---|---|
| `ADMIN_API_KEY` | Auth for all `/admin/*` endpoints | Set new value via CF REST API (see §7) |
| `STRIPE_WEBHOOK_SECRET` | Validates Stripe webhook signatures | Stripe dashboard → Developers → Webhooks → reveal signing secret |
| `STRIPE_SECRET_KEY` | Stripe API calls (retrieve subs, create portal sessions) | Stripe dashboard → Developers → API keys |
| `RESEND_API_KEY` | Sends transactional emails | Resend dashboard → API Keys |
| `SUPABASE_URL` | Supabase project URL | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (bypasses RLS) | Supabase → Project Settings → API → service_role |
| `GEMINI_API_KEY` | Google Gemini fallback | Google AI Studio |
| `KIMI_API_KEY` | Moonshot Kimi K2 (production AI) | https://platform.moonshot.cn |

**To rotate any secret:**
```powershell
$headers = @{ "Authorization" = "Bearer <CF_API_TOKEN>"; "Content-Type" = "application/json" }
$body = @{ name = "SECRET_NAME"; text = "new-value"; type = "secret_text" } | ConvertTo-Json
Invoke-RestMethod `
  -Uri "https://api.cloudflare.com/client/v4/accounts/001b9c277681a237d32b6a1413e101d4/workers/scripts/clippyai-api/secrets" `
  -Method Put -Headers $headers -Body $body
```

---

## 11. Plans & Token Budgets

| Plan | Price | Token budget | Desktop actions | Cost (Kimi K2) | Margin |
|---|---|---|---|---|---|
| Basic | $4.99/mo | 500,000 | ❌ | ~$0.36 | ~93% |
| Pro | $9.99/mo | 2,000,000 | ✅ | ~$1.43 | ~86% |
| Power | $19.99/mo | 5,000,000 | ✅ + multi-monitor | ~$3.58 | ~82% |

Tokens reset monthly on the subscription's `reset_date`. The cron job (runs every 15 min) catches any missed webhooks and auto-provisions within 15 minutes of a new subscription.

**Feature gates by plan:**

| Feature | Basic | Pro | Power |
|---|---|---|---|
| AI chat | ✅ | ✅ | ✅ |
| Desktop automation | ❌ | ✅ | ✅ |
| Browser control | ❌ | ✅ | ✅ |
| Multi-monitor | ❌ | ❌ | ✅ |
| Custom personas | ❌ | ❌ | ✅ |
| Priority support | ❌ | ❌ | ✅ |
