---
name: test-api
description: Test the spin wheel API endpoints. Use when the user wants to verify the server is working, test an endpoint, or check a response.
---

Test the spin wheel API. Use $ARGUMENTS to determine which target to hit:
- If $ARGUMENTS contains "prod" or "production" → use https://spin-wheel-puce.vercel.app
- Otherwise → use http://localhost:3000

Run these curl commands and report back what each returns:

1. Health check:
```
curl -s <BASE_URL>/health | jq .
```

2. Spin (test email — creates real Shopify resources on prod):
```
curl -s -X POST <BASE_URL>/api/spin \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","email":"test-claude@example.com"}' | jq .
```

3. Coupon fetch (use the customerId from the spin response above):
```
curl -s "<BASE_URL>/api/coupon?customerId=<ID>" | jq .
```

Summarise: which endpoints passed, what responses came back, and flag anything unexpected (non-200, missing fields, ALREADY_SPUN, etc.).
