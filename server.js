require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: `https://${process.env.SHOPIFY_STORE}` }));

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateCode(discount) {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `LUCKY${discount}-${rand}`;           // e.g. LUCKY20-3FA9C1B4
}

async function shopify(method, path, data = null) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const url   = `https://${store}/admin/api/2024-01${path}`;
  const opts  = {
    method,
    url,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  };
  if (data) opts.data = data;
  const res = await axios(opts);
  return res.data;
}

// ─── Create Price Rule + Discount Code ──────────────────────────────────────

async function createDiscount(discountPct, email) {
  const code = generateCode(discountPct);

  // 1. Price Rule (one-per-customer, single use total per code)
  const { price_rule } = await shopify('POST', '/price_rules.json', {
    price_rule: {
      title:             `SpinWin ${discountPct}% — ${email}`,
      target_type:       'line_item',
      target_selection:  'all',
      allocation_method: 'across',
      value_type:        'percentage',
      value:             `-${discountPct}.0`,
      customer_selection:'all',
      usage_limit:       1,               // entire code usable only once
      once_per_customer: true,            // belt-and-suspenders
      starts_at:         new Date().toISOString(),
    },
  });

  // 2. Discount Code under that rule
  const { discount_code } = await shopify(
    'POST',
    `/price_rules/${price_rule.id}/discount_codes.json`,
    { discount_code: { code } }
  );

  return { code, priceRuleId: price_rule.id, discountCodeId: discount_code.id };
}

// ─── Find or Create Customer + Save Metafield ───────────────────────────────

async function upsertCustomer(email, firstName) {
  const search = await shopify('GET',
    `/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`
  );

  if (search.customers.length > 0) {
    return search.customers[0].id;
  }

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

async function saveMetafield(customerId, payload) {
  // Check if metafield already exists (prevent double-spin)
  const existing = await shopify('GET',
    `/customers/${customerId}/metafields.json?namespace=spin_wheel&key=coupon`
  );
  if (existing.metafields.length > 0) {
    throw new Error('ALREADY_SPUN');     // customer already has a code
  }

  await shopify('POST', `/customers/${customerId}/metafields.json`, {
    metafield: {
      namespace: 'spin_wheel',
      key:       'coupon',
      type:      'json',
      value:     JSON.stringify(payload),
    },
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// POST /api/spin  →  spin result, create code, associate with customer
app.post('/api/spin', async (req, res) => {
  try {
    const { email, firstName, discount } = req.body;

    if (!email || !firstName)           return res.status(400).json({ error: 'Missing fields' });
    if (![10, 20, 30].includes(+discount)) return res.status(400).json({ error: 'Invalid discount' });

    const disc       = +discount;
    const customerId = await upsertCustomer(email, firstName);
    const { code, priceRuleId } = await createDiscount(disc, email);

    await saveMetafield(customerId, {
      code,
      discount:   disc,
      priceRuleId,
      used:       false,
      created_at: new Date().toISOString(),
    });

    return res.json({ success: true, code, discount: disc });

  } catch (err) {
    if (err.message === 'ALREADY_SPUN') {
      return res.status(409).json({ error: 'You have already claimed a discount.' });
    }
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/coupon?customerId=xxxxx  →  return saved coupon for logged-in user
app.get('/api/coupon', async (req, res) => {
  try {
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

    const data = await shopify('GET',
      `/customers/${customerId}/metafields.json?namespace=spin_wheel&key=coupon`
    );

    if (data.metafields.length === 0) return res.json({ coupon: null });

    const coupon = JSON.parse(data.metafields[0].value);
    return res.json({ coupon });

  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Failed to fetch coupon' });
  }
});

app.get('/auth', (req, res) => {
  const shop = process.env.SHOPIFY_STORE;
  const redirectUri = `https://${req.headers.host}/auth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_CLIENT_ID}` +
    `&scope=write_price_rules,write_discounts,write_customers,read_customers` +
    `&redirect_uri=${redirectUri}`;
  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const shop = process.env.SHOPIFY_STORE;
  const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
    client_id:     process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_SECRET,
    code,
  });
  const accessToken = tokenRes.data.access_token;
  console.log('✅ ACCESS TOKEN:', accessToken);
  res.send(`<h2>Success! Token saved to logs.</h2><p>Go copy it from Railway logs now.</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
