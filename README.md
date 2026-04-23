# 🎰 Spin Wheel — Shopify Discount Backend

A Node.js backend that powers the Logan Brewing **Spin-to-Win** popup.  
Integrates with the Shopify Admin API via an **App Proxy** to generate real discount codes, manage customers, and prevent duplicate spins.

---

## 🏗️ Architecture

```
Storefront Popup (Liquid + JS)
         │
         │  fetch('/tools/spin/api/spin')
         ▼
Shopify App Proxy (/tools/spin/*)
         │
         │  forwards to Railway backend
         ▼
Node.js / Express (Railway)
         │
         ├── Creates PriceRule + DiscountCode
         ├── Finds or Creates Customer
         ├── Sets Email Marketing Consent
         ├── Saves code to Customer Metafield
         └── Sends Account Invite Email
```

---

## 📁 Project Structure

```
spin-wheel/
├── server.js        ← entire backend (all routes + logic)
├── package.json     ← dependencies
├── Procfile         ← tells Railway how to start: web: node server.js
├── .gitignore       ← ignores node_modules/ and .env
└── README.md        ← this file
```

---

## ⚙️ Environment Variables

Set these in Railway → Variables:

| Variable | Example | Description |
|---|---|---|
| `SHOPIFY_STORE` | `logan-brewing.myshopify.com` | Your store domain |
| `SHOPIFY_ACCESS_TOKEN` | `shpat_xxxxx` | Admin API token from legacy custom app |
| `SHOPIFY_CLIENT_ID` | `4d8248ec...` | App Client ID from Dev Dashboard |
| `SHOPIFY_SECRET` | `your_secret` | App Secret from Dev Dashboard |
| `ADMIN_KEY` | `k7x9mq2p4r8tz3n6` | Your custom secret for admin routes |
| `PORT` | `8080` | Railway uses 8080 by default |

---

## 🚀 Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Fill in your values

# Start server
node server.js
# → ✅ Spin Wheel running on port 3000
```

---

## 📡 API Reference

### `GET /health`
Confirms the server is live and environment is loaded.

**Request:**
```
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "store": "logan-brewing.myshopify.com",
  "time": "2026-04-22T08:00:00.000Z"
}
```

---

### `POST /api/spin`
Main endpoint. Called when a customer submits the spin form.

**What it does internally:**
1. Validates `firstName`, `email`, `discount` (must be 10, 20, or 30)
2. Finds or creates Shopify customer
3. Sets `email_marketing_consent` to `subscribed`
4. Checks metafield — blocks if already spun (`ALREADY_SPUN`)
5. Creates a `PriceRule` with 7-day expiry
6. Creates a unique `DiscountCode` under that rule (`LUCKY20-F82330E8`)
7. Saves code + metadata to customer metafield
8. Sends Shopify account invite email to guest
9. Returns code + checkout URL

**Request:**
```http
POST /api/spin
Content-Type: application/json

{
  "firstName": "John",
  "email": "john@example.com",
  "discount": 20
}
```

**Success Response `200`:**
```json
{
  "success": true,
  "code": "LUCKY20-F82330E8",
  "discount": 20,
  "expires_at": "2026-04-29T08:00:00.000Z",
  "checkout_url": "https://logan-brewing.myshopify.com/discount/LUCKY20-F82330E8",
  "invite_sent": true
}
```

**Error Responses:**

| Status | Error | Reason |
|---|---|---|
| `400` | `Missing fields` | `firstName` or `email` not provided |
| `400` | `Invalid discount` | Discount not 10, 20, or 30 |
| `409` | `You have already claimed a discount.` | Same email spun before |
| `500` | `Something went wrong.` | Shopify API error — check Railway logs |

---

### `GET /api/coupon?customerId=xxxxx`
Returns the saved coupon for a logged-in customer.  
Used on the account page to display their code.

**Request:**
```
GET /api/coupon?customerId=7123456789
```

**Response — has coupon:**
```json
{
  "coupon": {
    "code": "LUCKY20-F82330E8",
    "discount": 20,
    "priceRuleId": 123456,
    "used": false,
    "created_at": "2026-04-22T08:00:00.000Z",
    "expires_at": "2026-04-29T08:00:00.000Z"
  }
}
```

**Response — no coupon:**
```json
{ "coupon": null }
```

**Response — expired:**
```json
{ "coupon": null, "reason": "expired" }
```

---

### `GET /auth`
OAuth Step 1 — redirects to Shopify login to install the app.

```
GET /auth
→ Redirects to https://logan-brewing.myshopify.com/admin/oauth/authorize?...
```

---

### `GET /auth/callback`
OAuth Step 2 — Shopify redirects here with a code.  
Exchanges the code for a permanent access token and displays it on screen.

```
GET /auth/callback?code=xxxxx&shop=logan-brewing.myshopify.com
→ Displays access token on page
→ Logs token to Railway console
```

---

### `GET /api/admin/fix-subscriptions` ⚠️ Admin Only
One-time utility to fix existing customers who were created without email subscription consent.

**Request:**
```http
GET /api/admin/fix-subscriptions
x-admin-key: your_admin_key_here
```

**Response:**
```json
{
  "success": true,
  "total": 8,
  "fixed": 6,
  "skipped": 2
}
```

> ⚠️ Requires `x-admin-key` header matching your `ADMIN_KEY` env variable.  
> Run once then optionally remove the route.

---

## 🔐 Security Features

| Feature | Implementation |
|---|---|
| Unique code per spin | `crypto.randomBytes(4)` → 4 billion combinations |
| Single use only | `usage_limit: 1` on PriceRule |
| No reuse per customer | `once_per_customer: true` on PriceRule |
| 7-day expiry | `ends_at` set on PriceRule creation |
| Double-spin prevention | Metafield check before creating code |
| Admin route protection | `x-admin-key` header required |
| Email verification | Shopify account invite sent after spin |

---

## 🛒 Shopify Resources Created Per Spin

Each successful spin creates these in Shopify:

```
PriceRule
  ├── title:              "SpinWin 20% — john@example.com"
  ├── value:              -20%
  ├── target_selection:   all
  ├── customer_selection: all
  ├── usage_limit:        1
  ├── once_per_customer:  true
  ├── starts_at:          now
  └── ends_at:            now + 7 days
        │
        └── DiscountCode
              └── code: "LUCKY20-F82330E8"

Customer (found or created)
  ├── first_name:    "John"
  ├── email:         "john@example.com"
  ├── tags:          "spin-wheel-winner"
  └── email_marketing_consent: subscribed
        │
        └── Metafield (namespace: spin_wheel, key: coupon)
              └── {
                    code:        "LUCKY20-F82330E8",
                    discount:    20,
                    priceRuleId: 123456,
                    used:        false,
                    created_at:  "2026-04-22...",
                    expires_at:  "2026-04-29..."
                  }
```

---

## 🔗 Key URLs

| Resource | URL |
|---|---|
| Railway backend | `https://spin-wheel-production-c4f7.up.railway.app` |
| Health check | `https://spin-wheel-production-c4f7.up.railway.app/health` |
| App Proxy base | `https://logan-brewing.myshopify.com/tools/spin` |
| Shopify Dev Dashboard | `https://dev.shopify.com/dashboard` |
| Railway dashboard | `https://railway.app` |
| Shopify Discounts | `https://admin.shopify.com/store/logan-brewing/discounts` |
| Shopify Customers | `https://admin.shopify.com/store/logan-brewing/customers` |

---

## 🧪 Testing with Postman / curl

### Health check
```bash
curl https://spin-wheel-production-c4f7.up.railway.app/health
```

### Test spin (creates real Shopify discount)
```bash
curl -X POST https://spin-wheel-production-c4f7.up.railway.app/api/spin \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","email":"test@example.com","discount":20}'
```

### Fetch saved coupon
```bash
curl "https://spin-wheel-production-c4f7.up.railway.app/api/coupon?customerId=7123456789"
```

### Fix subscriptions (admin)
```bash
curl https://spin-wheel-production-c4f7.up.railway.app/api/admin/fix-subscriptions \
  -H "x-admin-key: your_admin_key"
```

### Test via App Proxy (from storefront)
```bash
curl https://logan-brewing.myshopify.com/tools/spin/health
```

---

## 🐛 Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| `Cannot GET /` | No root route — expected | Use `/health` to test |
| `Cannot GET /api/spin` | It's POST only | Use Postman with POST method |
| `404` on proxy URL | Backend not running | Check Railway deployment logs |
| `401 Unauthorized` | Wrong `x-admin-key` | Check `ADMIN_KEY` Railway variable |
| `409 Already claimed` | Same email spun twice | Expected — working correctly |
| `500 Something went wrong` | Shopify API error | Check Railway logs for details |
| `Token undefined` | `SHOPIFY_ACCESS_TOKEN` missing | Add to Railway variables |
| Customers not subscribed | Old `accepts_marketing` field | Run `/api/admin/fix-subscriptions` |
| CSP error in browser console | Testing from admin panel | Test from storefront or use Postman |

---

## 📦 Dependencies

```json
{
  "express":            "^4.x",
  "cors":               "^2.x",
  "axios":              "^1.x",
  "dotenv":             "^16.x",
  "express-rate-limit": "^7.x"
}
```

Install:
```bash
npm install express cors axios dotenv express-rate-limit
```

---

## 🚢 Deployment (Railway)

1. Push to GitHub
2. Railway → New Project → GitHub Repository → select `spin-wheel`
3. Add all environment variables in Railway → Variables
4. Settings → Networking → Generate Domain
5. Update App URL + Proxy URL in Shopify Dev Dashboard → Versions

Auto-deploys on every `git push` to `main`.

---

## 📝 Shopify Theme Integration

The backend is called from:
- `sections/custom-hero-with-popup.liquid` — spin popup on homepage
- `sections/main-account.liquid` — coupon display on account page

App Proxy routes all `/tools/spin/*` requests from the storefront to this backend.

---

*Built for Logan Brewing by Prolix Web Studio*
