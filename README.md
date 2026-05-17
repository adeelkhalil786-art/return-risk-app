# Return Risk App — Setup Guide

## What it does
Every time a new order is placed, the app checks it against a local cache of all
past orders tagged **"Refusal"** and applies the tag **"Return Risk"** if:

- The **phone number** matches any past refusal order (exact, ignores formatting/country code)
- The **shipping address** is 70%+ similar to any past refusal order (handles typos, abbreviations)

The cache lives in a local SQLite file (`data/cache.db`) so checks are instant —
no Shopify API call needed per order. It stays fresh via:

- **Startup:** full load on boot
- **Real-time:** `orders/updated` webhook keeps cache in sync the moment you tag an order "Refusal"
- **Scheduled:** full refresh every 6 hours (configurable via `CACHE_TTL_HOURS`)
- **Manual:** `POST /cache/refresh` endpoint

---

## Prerequisites
- Node.js 18+ (with node-gyp / build tools for `better-sqlite3`)
- A publicly accessible server (or use [ngrok](https://ngrok.com) for testing)
- Shopify Admin access

---

## Step 1 — Create a Shopify Private App

1. Go to **Shopify Admin → Settings → Apps and sales channels**
2. Click **Develop apps** → **Create an app**
3. Name it: `Return Risk Detector`
4. Under **Configuration → Admin API scopes**, enable:
   - `read_orders`
   - `write_orders`
   - `write_customers` *(to tag the customer account)*
5. Click **Install app** and copy the **Admin API access token**

---

## Step 2 — Register TWO Webhooks

Go to **Shopify Admin → Settings → Notifications → Webhooks** and create:

| # | Event | URL |
|---|-------|-----|
| 1 | **Order creation** | `https://YOUR_SERVER/webhook/orders/create` |
| 2 | **Order update** | `https://YOUR_SERVER/webhook/orders/updated` |

Both use **JSON** format. Copy the **webhook signing secret** (same for both).

The second webhook (`orders/updated`) is what keeps the cache instantly up to date
when you manually apply or remove the "Refusal" tag on an order.

---

## Step 3 — Install and configure

```bash
git clone <your-repo>
cd return-risk-app
npm install        # installs express + better-sqlite3

cp .env.example .env
nano .env          # fill in your values
```

---

## Step 4 — Run

```bash
npm start
```

On startup you'll see:
```
🚀 Return Risk app starting on port 3000
🔄 Running full cache refresh from Shopify…
💾 Cache refreshed — 47 refusal orders stored
⏰ Cache auto-refresh every 6h
✅ Listening on port 3000
```

---

## Step 5 — Check cache status anytime

```bash
curl http://localhost:3000/cache/status
# → { "count": 47, "lastFullRefresh": "2024-01-15T08:00:00.000Z", "dbPath": "..." }
```

Force a manual refresh:
```bash
curl -X POST http://localhost:3000/cache/refresh
```

---

## Step 6 — Test locally

```bash
curl -X POST http://localhost:3000/webhook/orders/create \
  -H "Content-Type: application/json" \
  -d '{
    "order_number": 9999,
    "email": "sneaky@example.com",
    "phone": "+92-300-1234567",
    "shipping_address": {
      "phone": "+92-300-1234567",
      "address1": "House 5 Street 10 DHA Phase 6",
      "city": "Lahore",
      "zip": "54000"
    },
    "customer": { "id": 8888, "tags": "" },
    "tags": ""
  }'
```

*(Leave `SHOPIFY_WEBHOOK_SECRET` empty in `.env` to skip HMAC in dev)*

---

## Deploying

Any Node.js host works. Recommended:

- **Railway** — `railway up`, set env vars in dashboard
- **Render** — connect GitHub repo, set env vars, deploy
- **VPS** — run with `pm2 start index.js --name return-risk`

Make sure the `data/` directory is writable (the SQLite file lives there).

---

## Configuration

In `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SHOPIFY_SHOP` | — | `your-store.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | — | Admin API token |
| `SHOPIFY_WEBHOOK_SECRET` | — | Webhook signing secret |
| `PORT` | `3000` | Server port |
| `CACHE_TTL_HOURS` | `6` | How often to do a full cache refresh |

In `index.js`:

```js
const RISK_TAG          = 'Return Risk';  // tag applied to flagged orders/customers
const REFUSAL_TAG       = 'Refusal';      // your existing tag for known bad orders
const ADDRESS_THRESHOLD = 0.70;           // 0.0–1.0, raise for stricter matching
```
