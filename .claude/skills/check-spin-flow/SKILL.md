---
name: check-spin-flow
description: Audit the full spin flow in server.js for correctness — ordering of operations, the dangling discount gotcha, and the double-spin gate. Use when reviewing or modifying the spin logic.
---

Read server.js and audit the POST /api/spin handler plus its four helpers: weightedDiscount, upsertCustomer, createDiscount, saveMetafield.

Check for these specific issues:

1. **Operation order gotcha** — createDiscount() runs before saveMetafield(). If saveMetafield() throws ALREADY_SPUN, a dangling PriceRule + DiscountCode is created in Shopify but never stored or returned. Flag if any change moves or merges these steps in a way that makes it worse.

2. **Double-spin gate** — saveMetafield() checks for an existing metafield and throws ALREADY_SPUN. Confirm this check is still present and runs *after* createDiscount, not before.

3. **Parallel execution risk** — upsertCustomer and createDiscount now run with Promise.all(). This is intentional for speed. Flag only if saveMetafield is ever moved into the Promise.all() — that would break the gate.

4. **Webhook redemption logic** — in POST /api/webhooks/customer-updated, the code verifies HMAC, checks the spin-wheel-winner tag, fetches the metafield, then scans recent orders for the code. Confirm this order is intact and that already-used metafields are skipped early.

Report: a short pass/fail for each of the four checks, plus any other anomalies you spot.
