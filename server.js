require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(cors({ origin: '*' }));

// ─── Dynamic Shopify helper ───────────────────────────────────────────────────
async function shopify(method, path, data = null) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const opts  = {
    method,
    url: `https://${store}/admin/api/2026-04${path}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  };
  if (data) opts.data = data;
  const res = await axios(opts);
  return res.data;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateCode(discount) {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `LUCKY${discount}-${rand}`;
}

function getExpiryDate(days = 7) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ─── Create Price Rule + Discount Code ───────────────────────────────────────
async function createDiscount(discountPct, email) {
  const code      = generateCode(discountPct);
  const expiresAt = getExpiryDate(7); // code expires in 7 days

  const { price_rule } = await shopify('POST', '/price_rules.json', {
    price_rule: {
      title:             `SpinWin ${discountPct}% — ${email}`,
      target_type:       'line_item',
      target_selection:  'all',
      allocation_method: 'across',
      value_type:        'percentage',
      value:             `-${discountPct}.0`,
      customer_selection:'all',
      usage_limit:       1,
      once_per_customer: true,
      starts_at:         new Date().toISOString(),
      ends_at:           expiresAt,   // ← 7-day expiry
    },
  });

  const { discount_code } = await shopify(
    'POST',
    `/price_rules/${price_rule.id}/discount_codes.json`,
    { discount_code: { code } }
  );

  return {
    code,
    priceRuleId:    price_rule.id,
    discountCodeId: discount_code.id,
    expiresAt,
  };
}

// ─── Find or Create Customer (with email subscription) ───────────────────────
async function upsertCustomer(email, firstName) {
  const search = await shopify('GET',
    `/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`
  );

  if (search.customers.length > 0) {
    const existing = search.customers[0];

    // Update subscription if not already subscribed
    if (existing.email_marketing_consent?.state !== 'subscribed') {
      await shopify('PUT', `/customers/${existing.id}.json`, {
        customer: {
          id: existing.id,
          email_marketing_consent: {
            state:              'subscribed',
            opt_in_level:       'single_opt_in',
            consent_updated_at: new Date().toISOString(),
          },
        },
      });
    }

    return existing.id;
  }

  // Create new customer with email subscription
  const { customer } = await shopify('POST', '/customers.json', {
    customer: {
      first_name: firstName,
      email,
      tags:       'spin-wheel-winner',
      email_marketing_consent: {
        state:              'subscribed',      // ← Subscribed
        opt_in_level:       'single_opt_in',   // ← Form submission = consent
        consent_updated_at: new Date().toISOString(),
      },
    },
  });

  return customer.id;
}

// ─── Save Metafield (prevent double-spin) ────────────────────────────────────
async function saveMetafield(customerId, payload) {
  const existing = await shopify('GET',
    `/customers/${customerId}/metafields.json?namespace=spin_wheel&key=coupon`
  );
  if (existing.metafields.length > 0) throw new Error('ALREADY_SPUN');

  await shopify('POST', `/customers/${customerId}/metafields.json`, {
    metafield: {
      namespace: 'spin_wheel',
      key:       'coupon',
      type:      'json',
      value:     JSON.stringify(payload),
    },
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  store:  process.env.SHOPIFY_STORE,
  time:   new Date().toISOString(),
}));

// OAuth Step 1
app.get('/auth', (req, res) => {
  const shop        = process.env.SHOPIFY_STORE;
  const redirectUri = `https://${req.headers.host}/auth/callback`;
  const url         = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_CLIENT_ID}` +
    `&scope=write_price_rules,write_discounts,write_customers,read_customers` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

// OAuth Step 2
app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const shop     = process.env.SHOPIFY_STORE;
    const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id:     process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_SECRET,
      code,
    });
    const accessToken = tokenRes.data.access_token;
    console.log('✅ ACCESS TOKEN:', accessToken);
    res.send(`
      <h2 style="font-family:sans-serif;color:green">✅ Success!</h2>
      <p style="font-family:sans-serif">Add this to Railway as SHOPIFY_ACCESS_TOKEN:</p>
      <code style="font-size:18px;background:#f0f0f0;padding:10px;display:block">${accessToken}</code>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('OAuth failed: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// POST /api/spin — main spin endpoint
app.post('/api/spin', async (req, res) => {
  try {
    const { email, firstName, discount } = req.body;

    if (!email || !firstName)
      return res.status(400).json({ error: 'Missing fields' });
    if (![10, 20, 30].includes(+discount))
      return res.status(400).json({ error: 'Invalid discount' });

    const disc       = +discount;
    const customerId = await upsertCustomer(email, firstName);
    const { code, priceRuleId, expiresAt } = await createDiscount(disc, email);

    await saveMetafield(customerId, {
      code,
      discount:   disc,
      priceRuleId,
      used:       false,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    });

    return res.json({
      success:      true,
      code,
      discount:     disc,
      expires_at:   expiresAt,
      checkout_url: `https://${process.env.SHOPIFY_STORE}/discount/${code}`,
    });

  } catch (err) {
    if (err.message === 'ALREADY_SPUN')
      return res.status(409).json({ error: 'You have already claimed a discount.' });

    console.error('❌ /api/spin error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/coupon?customerId=xxx — fetch saved coupon for account page
app.get('/api/coupon', async (req, res) => {
  try {
    const { customerId } = req.query;
    if (!customerId)
      return res.status(400).json({ error: 'Missing customerId' });

    const data = await shopify('GET',
      `/customers/${customerId}/metafields.json?namespace=spin_wheel&key=coupon`
    );

    if (data.metafields.length === 0)
      return res.json({ coupon: null });

    const coupon = JSON.parse(data.metafields[0].value);

    // Check if expired
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.json({ coupon: null, reason: 'expired' });
    }

    return res.json({ coupon });

  } catch (err) {
    console.error('❌ /api/coupon error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch coupon' });
  }
});

// Add this temporary route to server.js
app.get('/api/admin/setup-webhook', async (req, res) => {
  const secret = req.headers['x-admin-key'];
  if (secret !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await shopify('POST', '/webhooks.json', {
      webhook: {
        topic:   'discounts/redeemcode_removed',
        address: 'https://spin-wheel-production-c4f7.up.railway.app/api/webhooks/code-redeemed',
        format:  'json',
      }
    });
    res.json({ success: true, webhook: result.webhook });
  } catch (err) {
    const shopifyError = err.response?.data || err.message;
    console.error('❌ Webhook setup failed:', shopifyError);
    res.status(500).json({ error: 'Webhook creation failed', details: shopifyError });
  }
});

app.post('/api/webhooks/customer-updated', async (req, res) => {
  console.log('🔔 customer-updated webhook received at', new Date().toISOString());

  try {
    const hmac      = req.headers['x-shopify-hmac-sha256'];
    const generated = crypto
      .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('base64');

    if (generated !== hmac) {
      console.error('❌ Webhook HMAC failed');
      return res.status(401).send('Unauthorized');
    }

    console.log('✅ HMAC verified');

    const payload    = req.body;
    const customerId = payload.id;
    console.log('🔔 customer id:', customerId);

    // ── Fetch FULL customer record from Shopify API ──────────────────────
    // Webhook payload doesn't always include tags — fetch to be sure
    const fullCustomer = await shopify('GET', `/customers/${customerId}.json`);
    const customer     = fullCustomer.customer;
    const tags         = customer.tags || '';

    console.log('🏷️ Full customer tags:', tags);

    if (!tags.includes('spin-wheel-winner')) {
      console.log('⏭️ Skipping — not a spin-wheel-winner');
      return res.status(200).send('OK');
    }

    console.log('🎯 Processing spin-wheel-winner customer:', customerId);

    // Get their spin wheel metafield
    const mf = await shopify('GET',
      `/customers/${customerId}/metafields.json?namespace=spin_wheel&key=coupon`
    );

    if (mf.metafields.length === 0) {
      console.log('⏭️ No metafield found for customer:', customerId);
      return res.status(200).send('OK');
    }

    const metafield = mf.metafields[0];
    const current   = JSON.parse(metafield.value);

    console.log('📋 Current metafield:', JSON.stringify(current));

    if (current.used) {
      console.log('ℹ️ Code already marked as used:', current.code);
      return res.status(200).send('OK');
    }

    // Check discount code usage in Shopify
    try {
      const dcData = await shopify('GET',
        `/price_rules/${current.priceRuleId}/discount_codes.json`
      );

      const discountCode = dcData.discount_codes.find(
        dc => dc.code === current.code
      );

      console.log('🔍 Discount code data:', JSON.stringify(discountCode));

      if (!discountCode) {
        throw new Error('Code not found — likely redeemed');
      }

      if (discountCode.usage_count >= 1) {
        throw new Error('usage_count >= 1 — redeemed');
      }

      console.log('ℹ️ Code still valid, usage_count:', discountCode.usage_count);
      return res.status(200).send('OK');

    } catch (checkErr) {
      console.log('🎯 Marking as redeemed:', checkErr.message);

      await shopify('PUT',
        `/customers/${customerId}/metafields/${metafield.id}.json`,
        {
          metafield: {
            id:    metafield.id,
            value: JSON.stringify({
              ...current,
              used:        true,
              redeemed_at: new Date().toISOString(),
            }),
            type: 'json',
          }
        }
      );

      console.log(`✅ Marked ${current.code} as redeemed for customer ${customerId}`);
      return res.status(200).send('OK');
    }

  } catch (err) {
    console.error('❌ Customer update webhook error:', err.message);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Spin Wheel running on port ${PORT}`));
