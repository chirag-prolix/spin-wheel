---
name: setup-webhook
description: Register the Shopify orders/paid webhook against the deployed Vercel backend. Use when deploying for the first time or after changing the backend URL.
---

There is no admin route for webhook registration — it must be done via the Shopify Admin API directly.

Run:
```
curl -s -X POST "https://${SHOPIFY_STORE}/admin/api/2026-01/webhooks.json" \
  -H "X-Shopify-Access-Token: ${SHOPIFY_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"webhook":{"topic":"orders/paid","address":"https://spin-wheel-puce.vercel.app/api/webhooks/order-paid","format":"json"}}' | jq .
```

Read `.env` to get `SHOPIFY_STORE` and `SHOPIFY_ACCESS_TOKEN` values, then substitute them into the command before running.

If the response contains `"id"`, the webhook was registered successfully — report the ID and address to the user.

If it fails:
- 422 / duplicate → webhook already exists, that's fine — list existing webhooks to confirm:
  `curl -s "https://<store>/admin/api/2026-01/webhooks.json" -H "X-Shopify-Access-Token: <token>" | jq .`
- 401 → wrong access token, check `.env`
- 500 → check Vercel logs for detail

Remind the user: if the backend URL ever changes, delete the old webhook from Shopify Admin → Settings → Notifications → Webhooks and re-register with the new URL.
