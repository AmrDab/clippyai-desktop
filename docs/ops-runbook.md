# ClippyAI — Ops Runbook

Everything you need to operate, monitor, and control ClippyAI as its owner.
Last updated: 2026-10-12

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
| API backend | Cloudflare Worker | `https://api.clippyai.app` (also `https://clippyai-api.amraldabbas19.workers.dev`) |
| Database | Supabase (Postgres) | https://supabase.com → ClippyAI project |
| Billing | Stripe | https://dashboard.stripe.com |
| Email | Resend | https://resend.com |
| Installer CDN | Cloudflare R2 | `clippyai-downloads` bucket → `download.clippyai.app` |
| Auto-update source | GitHub Releases | https://github.com/AmrDab/clippyai-desktop/releases |
| Landing page | Static site | `C:\Users\amr_d\clippyai-web` |

**AI backend:** DeepSeek V4 — Free = `deepseek-v4-flash`, Power/Max = `deepseek-v4-pro` (screenshot turns go to `deepseek-flash`, since v4-pro has no vision). Set per plan in `PLAN_MODELS` (`clippyai-api/src/lib/license.ts`); clients cannot choose the model.

---

## 2. Admin API

All admin endpoints live on the Worker. Auth header is the same for all:

```
Authorization: Bearer <ADMIN_API_KEY>
```

The `ADMIN_API_KEY` is stored as a Cloudflare Worker secret (write-only — not visible in the dashboard). Keep it in a password manager. If lost, set a new one (see §10). Never commit keys to this repo — it is public.

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
| `plan` | `"power"` | `"free"` / `"power"` / `"max"` (unknown plans → 400) |
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

**How keys work:**
1. Customer pays on Stripe → webhook fires → Worker creates Supabase row + emails key
2. Customer opens Clippy → enters key in Settings → app calls `POST /validate` → gets plan + token quota
3. Each AI turn deducts tokens from `tokens_used`; resets on `reset_date`

**To look up a key manually:** Supabase → Table Editor → `subscriptions` → filter `license_key = 'CLIPPY-...'`

**To revoke a key:** `POST /admin/revoke` with `{ "license_key": "CLIPPY-…" }` sets `status = 'cancelled'` — the key then falls back to the Free plan (ex-customers keep Free). For a leaked or abused key use `{ "license_key": "CLIPPY-…", "hard": true }`, which also renames the key so it stops working entirely.

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

Both channels must move together: GitHub Release (auto-update source) and R2 (website download).

```powershell
cd C:\Users\amr_d\ClippyAI
# 1. Bump the version: package.json + package-lock.json ("version") and electron-builder.yml (buildVersion X.Y.Z.0)
# 2. Write release/RELEASE_NOTES.md
npm run dist                      # signed build (Azure Artifact Signing) -> release/ClippyAI-Setup-X.Y.Z.exe + .blockmap + latest.yml
git tag -a vX.Y.Z -m "ClippyAI vX.Y.Z" <commit>; git push origin <branch> vX.Y.Z
& "C:\Program Files\Git\bin\bash.exe" scripts/publish-release.sh X.Y.Z   # GitHub release (--latest, NOT prerelease) + R2 upload
```

If the script's R2 step fails with `EBUSY` from `npx`, upload with the wrangler installed in `clippyai-api`:

```powershell
cd C:\Users\amr_d\clippyai-api
npx wrangler r2 object put "clippyai-downloads/ClippyAI-Setup-X.Y.Z.exe"  --file "C:\Users\amr_d\ClippyAI\release\ClippyAI-Setup-X.Y.Z.exe" --content-type "application/x-msdownload" --remote
npx wrangler r2 object put "clippyai-downloads/ClippyAI-Setup-latest.exe" --file "C:\Users\amr_d\ClippyAI\release\ClippyAI-Setup-X.Y.Z.exe" --content-type "application/x-msdownload" --remote
```

Verify: `curl -sI https://download.clippyai.app/ClippyAI-Setup-latest.exe` (Content-Length matches the new .exe) and the release's `latest.yml` shows the new version. electron-updater ignores prerelease-flagged releases.

### Deploy API changes

```powershell
cd C:\Users\amr_d\clippyai-api
npx wrangler deploy        # note the Version ID; roll back with: npx wrangler rollback <previous-version-id>
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

**To rotate any secret** (no trailing newline: a newline breaks timing-safe comparisons):
```bash
cd /c/Users/amr_d/clippyai-api
printf '%s' "new-value" | npx wrangler secret put SECRET_NAME
```
Or run `npx wrangler secret put SECRET_NAME` and paste the value at the prompt.

Current AI secret: `DEEPSEEK_API_KEY` (Kimi/Gemini keys are legacy).

---

## 11. Plans & Token Budgets

Source of truth: `clippyai-api/src/lib/license.ts` (`PLAN_TOKENS`, `PLAN_MODELS`, `PLAN_FEATURES`, `SELLABLE_PLANS`).

| Plan | Model | Notes |
|---|---|---|
| Free | deepseek-v4-flash | Chat only; 1 free Power task per day and 1 PC security check per week (Windows); first 3 onboarding turns unbilled |
| Power | deepseek-v4-pro | Desktop tools, security check |
| Max | deepseek-v4-pro | Same as Power with a larger monthly budget |

Legacy `basic`/`pro` rows are grandfathered. Stripe price -> plan mapping lives in `PRICE_TO_PLAN` (license.ts); a cron reconciles Stripe <-> Supabase every 15 minutes (`RECONCILE_MODE=apply`).
