# ClippyAI — Admin / Operator Handbook

> The single source of truth for anyone running ClippyAI day-to-day.
> **No secret values are written in this file.** Every credential below points
> to *where it lives* and *how to retrieve or rotate it*. If you need a value,
> pull it from the source — never paste it into a doc, chat, or commit.

Last updated: 2026-04-08

---

## 1. High-level architecture

```
                 clippyai.app (marketing)        api.clippyai.app (backend)
                 ├─ Cloudflare Pages             ├─ Cloudflare Worker
                 └─ Static HTML/CSS/JS           ├─ Stripe webhook handler
                                                 ├─ Chat / agent endpoints
                                                 └─ License validation

   Desktop app ──────────► api.clippyai.app ──────────► OpenAI / Gemini / Anthropic
        │                        │
        ▼                        ▼
   Local license            Supabase (Postgres)
   key in %APPDATA%         ├─ users
                            └─ subscriptions

   Stripe ◄──────► api.clippyai.app/webhooks/stripe
     │
     └─► Resend ──► customer email (license key)
```

---

## 2. Accounts & who owns what

| Service          | Login method                                  | What it holds                             |
| ---------------- | --------------------------------------------- | ----------------------------------------- |
| **Cloudflare**   | `amraldabbas19@gmail.com`                     | DNS, Pages, Workers, secrets              |
| **Stripe**       | `amraldabbas19@gmail.com`                     | Products, prices, subscriptions, payouts  |
| **Supabase**     | `amraldabbas19@gmail.com`                     | Postgres DB (users + subscriptions)       |
| **Resend**       | `amraldabbas19@gmail.com`                     | Transactional email (license keys)        |
| **OpenAI**       | `amraldabbas19@gmail.com`                     | LLM API                                   |
| **Google AI**    | `amraldabbas19@gmail.com`                     | Gemini API                                |
| **Anthropic**    | `amraldabbas19@gmail.com`                     | Claude API                                |
| **GitHub**       | `AmrDab`                                      | Source code repos                         |
| **Domain (.app)**| Registered via Cloudflare Registrar           | clippyai.app                              |

> Store each account's login in a password manager (1Password / Bitwarden).
> Enable 2FA on **all** of them. Stripe and Cloudflare are the crown jewels.

---

## 3. Repos

| Repo                         | Location                         | Purpose                                      |
| ---------------------------- | -------------------------------- | -------------------------------------------- |
| `ClippyAI` (desktop app)     | `C:\Users\amr_d\ClippyAI`        | Electron/Tauri desktop buddy                 |
| `clippyai-web` (marketing)   | `C:\Users\amr_d\clippyai-web`    | clippyai.app static site                     |
| `clippyai-api` (backend)     | `C:\Users\amr_d\clippyai-api`    | Cloudflare Worker — all server logic         |

---

## 4. Secrets inventory — where they live

**Golden rule: the canonical copy lives at the source (Stripe, Supabase, etc.).
The worker has a cached copy as a Wrangler secret. Never hand-type them into code.**

### 4.1 Cloudflare Worker secrets (`clippyai-api`)

Listed with `wrangler secret list` (from `C:\Users\amr_d\clippyai-api`):

| Secret name              | Source of truth                                     | Rotate how                                          |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------- |
| `STRIPE_SECRET_KEY`      | Stripe → Developers → API keys → Secret key (live)  | Roll in Stripe, then `wrangler secret put`          |
| `STRIPE_WEBHOOK_SECRET`  | Stripe → Developers → Webhooks → destination → Signing secret | Roll secret in webhook detail page, then `wrangler secret put` |
| `RESEND_API_KEY`         | resend.com → API Keys                               | Create new key, `wrangler secret put`, delete old   |
| `SUPABASE_URL`           | supabase.com → Project Settings → API → URL         | Fixed per project (doesn't rotate)                  |
| `SUPABASE_SERVICE_KEY`   | supabase.com → Project Settings → API → service_role| JWT Settings → "Generate new secret"                |
| `OPENAI_API_KEY`         | platform.openai.com → API keys                      | Create new, replace, revoke old                     |
| `GEMINI_API_KEY`         | aistudio.google.com → Get API key                   | Create new, replace, revoke old                     |
| `ANTHROPIC_API_KEY`      | console.anthropic.com → API Keys                    | Create new, replace, revoke old                     |

**To see current secret names (without values):**
```bash
cd C:\Users\amr_d\clippyai-api
npx wrangler secret list
```

**To set or rotate any secret:**
```bash
cd C:\Users\amr_d\clippyai-api
npx wrangler secret put STRIPE_SECRET_KEY    # will prompt for the value
# OR one-liner (avoid if shell history is sensitive):
echo "<NEW_VALUE>" | npx wrangler secret put STRIPE_SECRET_KEY
```

### 4.2 Cloudflare Pages (`clippyai-web`)

Currently no secrets needed — static site. Stripe Payment Links are public.

### 4.3 Desktop app

- API base URL is the only "config": `https://api.clippyai.app`
- No API keys are bundled with the app. The app authenticates to the backend
  using the **user's license key** (issued via Stripe webhook).

---

## 5. Stripe

- **Dashboard:** https://dashboard.stripe.com
- **Mode:** Live (the Test-mode toggle top-right must be OFF)
- **Products:** `ClippyAI Basic`, `ClippyAI Pro`, `ClippyAI Power`
- **Payment Links** (customers click these on clippyai.app):
  - Basic: `https://buy.stripe.com/dRmfZg9w9dtY2LrgaWe3e01`
  - Pro:   `https://buy.stripe.com/7sY6oGaAd2Pk71H2k6e3e02`
  - Power: `https://buy.stripe.com/4gMbJ0dMp9dI3Pve2Oe3e00`
- **Webhook destination:** `charismatic-harmony` → `https://api.clippyai.app/webhooks/stripe`
  - Events: `checkout.session.completed`, `customer.subscription.created`,
    `customer.subscription.updated`, `customer.subscription.deleted`,
    `invoice.payment_succeeded`, `invoice.payment_failed`
  - Signing secret: Stripe Dashboard → Developers → Webhooks → destination

### Common tasks

- **Check if a payment actually cleared:** Dashboard → Payments.
- **See active subscriptions:** Dashboard → Subscriptions.
- **Refund a customer:** Payments → the charge → `...` → Refund.
- **Cancel a customer:** Subscriptions → the sub → `...` → Cancel subscription.
- **Re-send a missed webhook:** Developers → Events → the event → Resend (or
  use the `/admin/provision` worker endpoint, §8).

---

## 6. Supabase

- **Dashboard:** https://supabase.com/dashboard
- **Project:** clippyai (URL is stored in `SUPABASE_URL` worker secret)
- **Tables:**
  - `users` — email, stripe_customer_id
  - `subscriptions` — license_key, plan, status, tokens_used, tokens_allowed,
    reset_date, stripe_sub_id
- **Schema DDL:** `C:\Users\amr_d\clippyai-api\schema.sql`
- **How to look up a customer's license key:**
  Dashboard → Table Editor → `subscriptions` → filter by `email`

---

## 7. Cloudflare

- **Dashboard:** https://dash.cloudflare.com
- **Zone:** `clippyai.app`
- **Pages project:** `clippyai` (serves clippyai.app)
- **Worker:** `clippyai-api` (serves api.clippyai.app)
- **Custom domains:**
  - `clippyai.app` → Pages project `clippyai`, branch `main`
  - `api.clippyai.app` → Worker `clippyai-api`

### Deploying

**Marketing site:**
```bash
cd C:\Users\amr_d\clippyai-web
npx wrangler pages deploy . --project-name=clippyai --branch=main --commit-dirty=true
```

**Backend worker:**
```bash
cd C:\Users\amr_d\clippyai-api
npx wrangler deploy
```

---

## 8. Emergency procedures

### 8.1 A paying customer didn't get their license key
1. Verify payment in Stripe Dashboard → Customers.
2. Check the webhook delivery: Stripe → Developers → Webhooks → destination → Event deliveries. If red, read the error.
3. If the webhook never fired, manually provision via the admin endpoint:
   ```bash
   curl -X POST https://api.clippyai.app/admin/provision \
     -H "Authorization: Bearer <STRIPE_WEBHOOK_SECRET>" \
     -H "Content-Type: application/json" \
     -d '{"email":"customer@example.com"}'
   ```
   Returns the license key in the response body. Copy it and email the customer
   manually if Resend is still failing.
4. Check Resend dashboard for email delivery status.

### 8.2 A secret leaks
1. **Rotate it at the source first** (Stripe / Resend / OpenAI / etc.).
2. Immediately set the new value on the worker:
   `cd clippyai-api && npx wrangler secret put <NAME>`
3. If the leaked secret was the Stripe webhook signing secret, roll it in
   Stripe Dashboard → Developers → Webhooks → destination → Signing secret → Roll.
4. Audit recent activity at the source for any unexpected usage.

### 8.3 The site is down
1. Check https://www.cloudflarestatus.com.
2. `curl -I https://clippyai.app/` and `curl -I https://api.clippyai.app/`.
3. `npx wrangler tail` in `clippyai-api` to see live logs.
4. Cloudflare Dashboard → Workers → clippyai-api → Logs.

### 8.4 Key hotkeys in Stripe dashboard
- `gd` → Dashboard
- `gc` → Customers
- `gp` → Payments
- `gs` → Subscriptions
- `gw` → Workbench (webhooks, logs, events)

---

## 9. Monthly health check (do this on the 1st of every month)

- [ ] Stripe → Payments → verify MRR matches expectation
- [ ] Stripe → Disputes → resolve any chargebacks
- [ ] Supabase → check `subscriptions` row count matches active Stripe subs
- [ ] Cloudflare → Workers → check error rate on `clippyai-api`
- [ ] Resend → check bounce / complaint rate
- [ ] OpenAI / Gemini / Anthropic → check billing, set budget alerts
- [ ] Rotate `STRIPE_SECRET_KEY` if anyone new touched the repo

---

## 10. Contact points

- Customer support inbox: `hello@clippyai.app`
- Stripe support: dashboard → bottom-right chat bubble
- Cloudflare support: dashboard → Support (paid plans only get fast response)
- Legal pages: `/privacy`, `/terms`, `/refund` on clippyai.app
