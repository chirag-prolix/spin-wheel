# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Working Principles

- **Think Before Coding** — Ask instead of assuming. If the intent is ambiguous, clarify before writing code.
- **Simplicity First** — No abstractions nobody asked for. The entire backend is intentionally one file (`server.js`).
- **Surgical Changes** — Touch only what you must; every changed line must trace back to the request.
- **Goal-Driven Execution** — Define success criteria, not just steps. Know what "done" looks like before starting.

---

## Running the Server

```bash
cp .env.example .env   # then fill in values
npm install
node server.js         # → ✅ Spin Wheel running on port 3000
```

There are no automated tests. Manual testing is done via curl or Postman. The deployed URL is `https://spin-wheel-puce.vercel.app`.

---

## Manual Testing (curl)

```bash
# Health check
curl https://spin-wheel-puce.vercel.app/health

# Trigger a spin (creates real Shopify resources)
curl -X POST https://spin-wheel-puce.vercel.app/api/spin \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","email":"test@example.com"}'

# Fetch saved coupon for a customer
curl "https://spin-wheel-puce.vercel.app/api/coupon?customerId=7123456789"

# Verify App Proxy routing (from storefront context)
curl https://logan-brewing.myshopify.com/tools/spin/health
```

---

## Architecture

This is a single-file Node.js/Express backend (`server.js`) deployed as a Vercel serverless function. `api/index.js` is just a one-line re-export of `server.js` — Vercel routes all traffic there via `vercel.json`.

**Request flow:**
```
Shopify Storefront (Liquid popup)
  → Shopify App Proxy (/tools/spin/*)
    → Vercel (api/index.js → server.js)
      → Shopify Admin API (2026-01)
```

The App Proxy is what allows the storefront to call this backend without CORS issues — all `/tools/spin/*` requests on the Shopify storefront are transparently forwarded to Vercel.

---

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness check |
| `GET` | `/auth` | — | OAuth Step 1 — redirects to Shopify |
| `GET` | `/auth/callback` | — | OAuth Step 2 — exchanges code for access token |
| `POST` | `/api/spin` | — | Main spin endpoint |
| `GET` | `/api/coupon` | — | Fetch saved coupon by `?customerId=` |
| `POST` | `/api/webhooks/customer-updated` | HMAC | Marks metafield `used: true` on redemption |

---

## Core Spin Flow (`POST /api/spin`)

Request body: `{ email, firstName }` — **discount is server-determined, not supplied by the client.**

1. `weightedDiscount()` picks 10% (60%), 20% (30%), or 30% (10%)
2. `upsertCustomer()` — finds or creates a Shopify customer and sets email marketing consent
3. `createDiscount()` — creates a `PriceRule` + `DiscountCode` via Shopify Admin API (7-day expiry, single-use)
4. `saveMetafield()` — saves coupon data to `spin_wheel/coupon` metafield; throws `ALREADY_SPUN` if one exists (this is the double-spin gate)

> ⚠️ **Gotcha:** `createDiscount()` runs *before* `saveMetafield()`. If a customer is already blocked (`ALREADY_SPUN`), a dangling `PriceRule` + `DiscountCode` is created in Shopify but never returned or stored. These accumulate silently.

**Webhook** (`POST /api/webhooks/customer-updated`): Listens for Shopify customer update events. When a `spin-wheel-winner` customer places an order using their spin code, it marks the metafield `used: true`. HMAC verified via `SHOPIFY_WEBHOOK_SECRET`.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `SHOPIFY_STORE` | Store domain (e.g. `logan-brewing.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | Admin API token from legacy custom app |
| `SHOPIFY_CLIENT_ID` | App Client ID (OAuth only) |
| `SHOPIFY_SECRET` | App Secret (OAuth only) |
| `SHOPIFY_WEBHOOK_SECRET` | Used to verify Shopify webhook HMAC signatures |
| `APP_URL` | Deployed Vercel URL — used when registering webhooks |

---

## Known Issues / Notes

- `express-rate-limit` is listed in `package.json` but is **not wired up** in `server.js`.
- The Shopify Admin API version is hardcoded to `2026-01` inside the `shopify()` helper function — update it there if the API version needs to change.

---

## Deployment

Vercel auto-deploys on every push to `main`. After deploying:
- Update `APP_URL` env var in Vercel if the domain changed
- Update the App Proxy URL in Shopify Dev Dashboard → App → Versions if the backend URL changed

The Shopify theme integration lives in `sections/custom-hero-with-popup.liquid` (spin popup) and `sections/main-account.liquid` (coupon display on account page) — those are in the Shopify theme repo, not here.
