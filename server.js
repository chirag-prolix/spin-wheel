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

const SHOPIFY_STORE        = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_BASE_URL     = `https://${SHOPIFY_STORE}/admin/api/2026-01`;
const MF_NAMESPACE         = 'spin_wheel';
const MF_KEY               = 'coupon';

// ─── Shopify API helper ───────────────────────────────────────────────────────
async function shopify(method, path, data = null) {
  const opts = {
    method,
    url: `${SHOPIFY_BASE_URL}${path}`,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
  };
  if (data) opts.data = data;
  const res = await axios(opts);
  return res.data;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function nowISO() {
  return new Date().toISOString();
}

function generateCode(discount) {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `LUCKY${discount}-${rand}`;
}

function getExpiryDate(days = 7) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// Weighted random — adjust percentages here (must sum to 100)
function weightedDiscount() {
  const rand = Math.random() * 100;
  if (rand < 60) return 10;  // 60% chance
  if (rand < 90) return 20;  // 30% chance
  return 30;                  // 10% chance
}

async function getSpinMetafield(customerId) {
  const data = await shopify('GET',
    `/customers/${customerId}/metafields.json?namespace=${MF_NAMESPACE}&key=${MF_KEY}`
  );
  return data.metafields[0] ?? null;
}

// ─── Create Price Rule + Discount Code ───────────────────────────────────────
async function createDiscount(discountPct, email) {
  const code      = generateCode(discountPct);
  const expiresAt = getExpiryDate(7);

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
      starts_at:         nowISO(),
      ends_at:           expiresAt,
    },
  });

  await shopify(
    'POST',
    `/price_rules/${price_rule.id}/discount_codes.json`,
    { discount_code: { code } }
  );

  return { code, priceRuleId: price_rule.id, expiresAt };
}

// ─── Find or Create Customer (with email subscription) ───────────────────────
async function upsertCustomer(email, firstName) {
  const search = await shopify('GET',
    `/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`
  );

  if (search.customers.length > 0) {
    const existing = search.customers[0];

    const existingTags  = (existing.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const needsTag      = !existingTags.includes('spin-wheel-winner');
    const needsConsent  = existing.email_marketing_consent?.state !== 'subscribed';

    if (needsTag || needsConsent) {
      const update = { id: existing.id };
      if (needsTag)
        update.tags = [...existingTags, 'spin-wheel-winner'].join(', ');
      if (needsConsent)
        update.email_marketing_consent = {
          state:              'subscribed',
          opt_in_level:       'single_opt_in',
          consent_updated_at: nowISO(),
        };
      await shopify('PUT', `/customers/${existing.id}.json`, { customer: update });
    }

    return existing.id;
  }

  const { customer } = await shopify('POST', '/customers.json', {
    customer: {
      first_name: firstName,
      email,
      tags:       'spin-wheel-winner',
      email_marketing_consent: {
        state:              'subscribed',
        opt_in_level:       'single_opt_in',
        consent_updated_at: nowISO(),
      },
    },
  });

  return customer.id;
}

// ─── Save Metafield (prevent double-spin) ────────────────────────────────────
async function saveMetafield(customerId, payload) {
  const existing = await getSpinMetafield(customerId);
  if (existing) throw new Error('ALREADY_SPUN');

  await shopify('POST', `/customers/${customerId}/metafields.json`, {
    metafield: {
      namespace: MF_NAMESPACE,
      key:       MF_KEY,
      type:      'json',
      value:     JSON.stringify(payload),
    },
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  store:  SHOPIFY_STORE,
  time:   nowISO(),
}));

// OAuth Step 1
app.get('/auth', (req, res) => {
  const redirectUri = `https://${req.headers.host}/auth/callback`;
  const url         = `https://${SHOPIFY_STORE}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_CLIENT_ID}` +
    `&scope=write_price_rules,write_discounts,write_customers,read_customers` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

// OAuth Step 2
app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenRes = await axios.post(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      client_id:     process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_SECRET,
      code,
    });
    const accessToken = tokenRes.data.access_token;
    console.log('✅ ACCESS TOKEN:', accessToken);
    res.send(`
      <h2 style="font-family:sans-serif;color:green">✅ Success!</h2>
      <p style="font-family:sans-serif">Add this to Vercel as SHOPIFY_ACCESS_TOKEN:</p>
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
    const { email, firstName } = req.body;

    if (!email || !firstName)
      return res.status(400).json({ error: 'Missing fields' });

    const disc = weightedDiscount();
    const [customerId, { code, priceRuleId, expiresAt }] = await Promise.all([
      upsertCustomer(email, firstName),
      createDiscount(disc, email),
    ]);

    await saveMetafield(customerId, {
      code,
      discount:   disc,
      priceRuleId,
      used:       false,
      created_at: nowISO(),
      expires_at: expiresAt,
    });

    return res.json({
      success:      true,
      code,
      discount:     disc,
      expires_at:   expiresAt,
      customerId,
      checkout_url: `https://${SHOPIFY_STORE}/discount/${code}`,
    });

  } catch (err) {
    if (err.message === 'ALREADY_SPUN')
      return res.status(409).json({ error: 'You have already claimed a discount.' });

    console.error('❌ /api/spin error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/coupon?customerId=xxx  — or —  ?email=xxx
app.get('/api/coupon', async (req, res) => {
  try {
    let { customerId, email } = req.query;

    if (!customerId && !email)
      return res.status(400).json({ error: 'Missing customerId or email' });

    if (!customerId) {
      const search = await shopify('GET',
        `/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`
      );
      if (!search.customers.length)
        return res.json({ coupon: null });
      customerId = search.customers[0].id;
    }

    const metafield = await getSpinMetafield(customerId);

    if (!metafield)
      return res.json({ coupon: null });

    const coupon = JSON.parse(metafield.value);

    if (coupon.expires_at && new Date(coupon.expires_at) < new Date())
      return res.json({ coupon: null, reason: 'expired' });

    return res.json({ coupon });

  } catch (err) {
    console.error('❌ /api/coupon error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch coupon' });
  }
});

app.post('/api/webhooks/customer-updated', async (req, res) => {
  console.log('🔔 customer-updated webhook received at', nowISO());

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

    const customerId = req.body.id;
    console.log('🔔 customer id:', customerId);

    let customer;
    try {
      const result = await shopify('GET', `/customers/${customerId}.json`);
      customer = result.customer;
    } catch (fetchErr) {
      if (fetchErr.response?.status === 404) {
        console.log('⏭️ Customer not found — skipping:', customerId);
        return res.status(200).send('OK');
      }
      throw fetchErr;
    }

    const tags = customer.tags || '';
    console.log('🏷️ Full customer tags:', tags);

    if (!tags.includes('spin-wheel-winner')) {
      console.log('⏭️ Skipping — not a spin-wheel-winner');
      return res.status(200).send('OK');
    }

    console.log('🎯 Processing spin-wheel-winner customer:', customerId);

    const metafield = await getSpinMetafield(customerId);

    if (!metafield) {
      console.log('⏭️ No metafield found');
      return res.status(200).send('OK');
    }

    const current = JSON.parse(metafield.value);

    console.log('📋 Current metafield:', JSON.stringify(current));

    if (current.used) {
      console.log('ℹ️ Already marked as used');
      return res.status(200).send('OK');
    }

    const ordersData = await shopify('GET',
      `/customers/${customerId}/orders.json?status=any&limit=10`
    );

    console.log('📦 Recent orders count:', ordersData.orders.length);

    const codeUsedInOrder = ordersData.orders.some(order =>
      (order.discount_codes || []).some(dc => dc.code === current.code)
    );

    if (!codeUsedInOrder) {
      console.log('ℹ️ Code not used in any order — skipping');
      return res.status(200).send('OK');
    }

    await shopify('PUT',
      `/customers/${customerId}/metafields/${metafield.id}.json`,
      {
        metafield: {
          id:    metafield.id,
          value: JSON.stringify({ ...current, used: true, redeemed_at: nowISO() }),
          type:  'json',
        }
      }
    );

    console.log(`✅ Marked ${current.code} as redeemed for customer ${customerId}`);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.status(500).send('Error');
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Spin Wheel running on port ${PORT}`));
}

module.exports = app;
