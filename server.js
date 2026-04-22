require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));   // tighten to your domain after testing

// ─── Dynamic Shopify helper (reads env fresh each call) ──────────────────────
async function shopify(method, path, data = null) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const opts  = {
    method,
    url: `https://${store}/admin/api/2024-01${path}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  };
  if (data) opts.data = data;
  const res = await axios(opts);
  return res.data;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateCode(discount) {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `LUCKY${discount}-${rand}`;
}

// ─── Create Price Rule + Discount Code ───────────────────────────────────────
async function createDiscount(discountPct, email) {
  const code = generateCode(discountPct);
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
    },
  });
  const { discount_code } = await shopify(
    'POST',
    `/price_rules/${price_rule.id}/discount_codes.json`,
    { discount_code: { code } }
  );
  return { code, priceRuleId: price_rule.id, discountCodeId: discount_code.id };
}

// ─── Find or Create Customer ──────────────────────────────────────────────────
async function upsertCustomer(email, firstName) {
  const search = await shopify('GET',
    `/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`
  );
  if (search.customers.length > 0) return search.customers[0].id;
  const { customer } = await shopify('POST', '/customers.json', {
    customer: {
      first_name:        firstName,
      email,
      accepts_marketing: true,
      tags:              'spin-wheel-winner',
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

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check — confirms server is alive
app.get('/health', (req, res) => res.json({ status: 'ok', store: process.env.SHOPIFY_STORE }));

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
    const shop = process.env.SHOPIFY_STORE;
    const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id:     process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_SECRET,
      code,
    });
    const accessToken = tokenRes.data.access_token;
    console.log('✅ ACCESS TOKEN:', accessToken);
    res.send(`
      <h2 style="font-family:sans-serif;color:green">✅ Success!</h2>
      <p style="font-family:sans-serif">Copy this token and add it to Railway variables as SHOPIFY_ACCESS_TOKEN:</p>
      <code style="font-size:18px;background:#f0f0f0;padding:10px;display:block">${accessToken}</code>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('OAuth failed: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// POST /api/spin
app.post('/api/spin', async (req, res) => {
  try {
    const { email, firstName, discount } = req.body;
    if (!email || !firstName)              return res.status(400).json({ error: 'Missing fields' });
    if (![10, 20, 30].includes(+discount)) return res.status(400).json({ error: 'Invalid discount' });
    const disc       = +discount;
    const customerId = await upsertCustomer(email, firstName);
    const { code, priceRuleId } = await createDiscount(disc, email);
    await saveMetafield(customerId, {
      code, discount: disc, priceRuleId,
      used: false, created_at: new Date().toISOString(),
    });
    return res.json({ success: true, code, discount: disc });
  } catch (err) {
    if (err.message === 'ALREADY_SPUN')
      return res.status(409).json({ error: 'You have already claimed a discount.' });
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/coupon
app.get('/api/coupon', async (req, res) => {
  try {
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'Missing customerId' });
    const data = await shopify('GET',
      `/customers/${customerId}/metafields.json?namespace=spin_wheel&key=coupon`
    );
    if (data.metafields.length === 0) return res.json({ coupon: null });
    return res.json({ coupon: JSON.parse(data.metafields[0].value) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch coupon' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
