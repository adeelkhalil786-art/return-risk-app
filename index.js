const express = require('express');
const crypto  = require('crypto');
const cache   = require('./cache');
const app     = express();

// ── Config ────────────────────────────────────────────────────────────────────
const {
  SHOPIFY_SHOP,           // e.g. your-store.myshopify.com
  SHOPIFY_ACCESS_TOKEN,   // Admin API token
  SHOPIFY_WEBHOOK_SECRET,
  PORT              = 3000,
  CACHE_TTL_HOURS   = 6,    // full refresh interval
} = process.env;

const RISK_TAG           = 'Return Risk';
const REFUSAL_TAG        = 'Refusal';
const ADDRESS_THRESHOLD  = 0.85; // raised from 70% to reduce false positives
const CACHE_TTL_MS       = Number(CACHE_TTL_HOURS) * 60 * 60 * 1000;

// ── Raw body for HMAC (must come before express.json) ────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Health / status ───────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('Return Risk app is running ✓'));

app.get('/cache/status', (_req, res) => {
  res.json(cache.stats());
});

app.post('/cache/refresh', async (_req, res) => {
  try {
    await fullRefresh();
    res.json({ ok: true, ...cache.stats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Webhook: orders/create ────────────────────────────────────────────────────
app.post('/webhook/orders/create', async (req, res) => {
  if (!verifyHmac(req)) {
    console.warn('⚠️  HMAC verification failed (orders/create)');
    return res.status(401).send('Unauthorized');
  }
  res.status(200).send('OK');

  try {
    const order = JSON.parse(req.body);
    console.log(`\n📦 New order #${order.order_number} — running risk check…`);
    await processOrder(order);
  } catch (err) {
    console.error('Error processing order:', err.message);
  }
});

// ── Webhook: orders/updated ───────────────────────────────────────────────────
// Fires when a Refusal tag is added to an existing order.
// We ONLY add to cache here — never remove.
// Cache cleanup happens naturally on the 6h scheduled full refresh.
app.post('/webhook/orders/updated', async (req, res) => {
  if (!verifyHmac(req)) {
    console.warn('⚠️  HMAC verification failed (orders/updated)');
    return res.status(401).send('Unauthorized');
  }
  res.status(200).send('OK');

  try {
    const order = JSON.parse(req.body);
    const tags  = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
    const hasRefusal = tags.includes(REFUSAL_TAG.toLowerCase());

    if (hasRefusal) {
      cache.upsertOrder(buildCacheEntry(order));
      console.log(`\n🔄 Order #${order.order_number} tagged Refusal — added to cache`);
    }
    // If no Refusal tag — do nothing. Never evict from cache here.
  } catch (err) {
    console.error('Error handling orders/updated:', err.message);
  }
});

// ── Core matching logic ───────────────────────────────────────────────────────
async function processOrder(order) {
  const orderPhone   = normalizePhone(order.shipping_address?.phone || order.phone || '');
  const orderAddress = normalizeAddress(order.shipping_address);
  const orderEmail   = (order.email || '').toLowerCase().trim();

  console.log(`   Phone:   ${orderPhone || '(none)'}`);
  console.log(`   Address: ${orderAddress || '(none)'}`);

  const refusalOrders = cache.getAll();
  console.log(`   Checking against ${refusalOrders.length} cached refusal orders…`);

  let matchFound  = false;
  let matchReason = '';

  for (const past of refusalOrders) {
    if (String(past.order_id) === String(order.id)) continue;

    // Skip same account
    if (orderEmail && past.email && past.email === orderEmail) continue;

    // ── Match 1: Phone ────────────────────────────────────────────────────
    if (orderPhone && past.phone && orderPhone === past.phone) {
      matchFound  = true;
      matchReason = `phone match (${orderPhone}) — matches refusal order #${past.order_number}`;
      break;
    }

    // ── Match 2: Address similarity ───────────────────────────────────────
    if (orderAddress && past.address) {
      const similarity = jaroWinkler(orderAddress, past.address);
      if (similarity >= ADDRESS_THRESHOLD) {
        matchFound  = true;
        matchReason = `address match (${Math.round(similarity * 100)}% similarity) — matches refusal order #${past.order_number}`;
        break;
      }
    }
  }

  if (!matchFound) {
    console.log('   ✅ No risk match — order is clean');
    return;
  }

  console.log(`   🚨 MATCH: ${matchReason}`);
  await tagOrder(order.id, order.tags, matchReason);

  if (order.customer?.id) {
    await tagCustomer(order.customer.id, order.customer.tags, matchReason);
  }
}

// ── Cache refresh ─────────────────────────────────────────────────────────────
async function fullRefresh() {
  console.log('\n🔄 Running full cache refresh from Shopify…');
  const refusalOrders = await fetchAllRefusalOrders();
  const entries = refusalOrders.map(buildCacheEntry);
  cache.replaceAll(entries);
}

function buildCacheEntry(order) {
  return {
    id:           order.id,
    order_number: order.order_number,
    email:        (order.email || '').toLowerCase().trim() || null,
    phone:        normalizePhone(order.shipping_address?.phone || order.phone || '') || null,
    address:      normalizeAddress(order.shipping_address) || null,
    city:         (order.shipping_address?.city || '').toLowerCase().trim() || null,
  };
}

// ── Scheduled refresh ─────────────────────────────────────────────────────────
function startScheduler() {
  console.log(`⏰ Cache auto-refresh every ${CACHE_TTL_HOURS}h`);
  setInterval(async () => {
    try {
      await fullRefresh();
    } catch (err) {
      console.error('Scheduled refresh failed:', err.message);
    }
  }, CACHE_TTL_MS);
}

// ── Shopify API helpers ───────────────────────────────────────────────────────
async function shopifyFetch(path, method = 'GET', body = null) {
  const url  = `https://${SHOPIFY_SHOP}/admin/api/2024-07${path}`;
  const opts = {
    method,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15000), // 15 second timeout
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return { data: await res.json(), headers: res.headers };
}

async function fetchAllRefusalOrders() {
  const refusalOrders = [];
  let pageInfo    = null;
  let isFirstPage = true;

  while (isFirstPage || pageInfo) {
    isFirstPage = false;

    // Shopify does not allow ?fields combined with ?page_info — causes 400
    // First page: filter by status. Subsequent pages: page_info only.
    const path = pageInfo
      ? `/orders.json?limit=250&page_info=${pageInfo}`
      : `/orders.json?status=any&limit=250`;

    const { data, headers } = await shopifyFetch(path);
    for (const o of (data.orders || [])) {
      const tags = (o.tags || '').split(',').map(t => t.trim().toLowerCase());
      if (tags.includes(REFUSAL_TAG.toLowerCase())) refusalOrders.push(o);
    }

    const link = headers.get('link') || '';
    const next = link.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    pageInfo = next ? next[1] : null;
  }

  return refusalOrders;
}

async function tagOrder(orderId, existingTags, reason) {
  const tags = mergeTags(existingTags, RISK_TAG);
  await shopifyFetch(`/orders/${orderId}.json`, 'PUT', {
    order: { id: orderId, tags, note: `Auto-flagged: ${reason}` },
  });
  console.log(`   🏷️  Order tagged "${RISK_TAG}"`);
}

async function tagCustomer(customerId, existingTags, reason) {
  const tags = mergeTags(existingTags, RISK_TAG);
  await shopifyFetch(`/customers/${customerId}.json`, 'PUT', {
    customer: { id: customerId, tags, note: `Auto-flagged: ${reason}` },
  });
  console.log(`   🏷️  Customer tagged "${RISK_TAG}"`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function mergeTags(existing, newTag) {
  const list = (existing || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!list.includes(newTag)) list.push(newTag);
  return list.join(', ');
}

function normalizePhone(phone) {
  return phone.replace(/\D/g, '').slice(-10);
}

function normalizeAddress(addr) {
  if (!addr) return '';
  return [addr.address1 || '', addr.address2 || '', addr.city || '', addr.zip || '']
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const len1 = s1.length, len2 = s2.length;
  const matchDist = Math.floor(Math.max(len1, len2) / 2) - 1;
  if (matchDist < 0) return 0;

  const s1m = new Array(len1).fill(false);
  const s2m = new Array(len2).fill(false);
  let matches = 0, transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end   = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue;
      s1m[i] = s2m[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (s1[i] === s2[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function verifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true;
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
function boot() {
  console.log(`🚀 Return Risk app starting on port ${PORT}`);
  console.log(`   Shop: ${SHOPIFY_SHOP}`);
  console.log(`   Risk tag: "${RISK_TAG}"  |  Source tag: "${REFUSAL_TAG}"`);
  console.log(`   Address threshold: ${ADDRESS_THRESHOLD * 100}%`);

  // IMPORTANT: listen first, cache after — Render requires port open within 3min
  const server = app.listen(PORT, () => {
    console.log(`✅ Listening on port ${PORT}`);
  });

  server.on('listening', () => {
    // Load cache in background after port is open
    setTimeout(() => {
      fullRefresh()
        .catch(err => console.warn(`⚠️  Initial cache load failed: ${err.message}`));
      startScheduler();
    }, 1000);
  });
}

boot();
