---
name: setup-webhook
description: Register the Shopify customer-updated webhook against the deployed Vercel backend. Use when deploying for the first time or after changing the APP_URL.
---

Register the Shopify webhook by calling the admin setup route.

You'll need the ADMIN_KEY from the .env file (or Vercel env vars). Read .env to get it if available.

Run:
```
curl -s https://spin-wheel-puce.vercel.app/api/admin/setup-webhook \
  -H "x-admin-key: <ADMIN_KEY>" | jq .
```

If the response contains `"success": true`, report the webhook ID and topic.

If it fails:
- 401 → wrong ADMIN_KEY, check .env or Vercel env vars
- 422 / duplicate → webhook already exists, that's fine — list existing webhooks for the user to confirm
- 500 → check Vercel logs for the Shopify API error detail

Remind the user: this only needs to be run once per deployment URL. If APP_URL changes, the old webhook still points to the old URL and must be deleted from Shopify Admin → Settings → Notifications → Webhooks.
