'use strict';

/**
 * QuoteUnquote — Express API + static host. 100% Custom Print-On-Demand.
 *
 * Every order is a custom tee: handle + comment + user-cropped circular avatar.
 * There is no bulk/inventory/curated path.
 *
 *   POST /api/checkout            validate mandatory custom schema -> price
 *                                 server-side -> persist avatars -> Stripe PI
 *   POST /api/webhooks/stripe     idempotent -> render 300 DPI print (avatar
 *                                 composited) -> upload -> Printify DRAFT
 *                                 (on-hold) -> quarantine on bad image
 *   GET  /api/admin/pending       token-gated draft queue for human approval
 *   GET  /api/orders/track/:token self-service tracking
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const Stripe = require('stripe');

const cfg = require('./src/config');
const db = require('./src/db');
const sanitize = require('./src/sanitize');
const printEngine = require('./src/printEngine');
const printify = require('./src/printify');
const capi = require('./src/capi');
const cleanup = require('./src/cleanup');
const { notifyAdmin } = require('./src/notify');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const IS_PROD = process.env.NODE_ENV === 'production';
const { STATUS, PRINTIFY } = cfg;

// Transient on-disk stores (avatars in / print files out). Kept off the JSON
// store to avoid base64 bloat; regenerated/uploaded to Printify during fulfil.
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const PRINTS_DIR = path.join(__dirname, 'data', 'prints');
for (const d of [UPLOADS_DIR, PRINTS_DIR]) fs.mkdirSync(d, { recursive: true });

// Retention sweeper: prune generated avatars/prints after their window (they
// live on Printify once uploaded). Unref'd — never holds the process open.
cleanup.start([UPLOADS_DIR, PRINTS_DIR]);

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_KEY && STRIPE_KEY.startsWith('sk_') ? new Stripe(STRIPE_KEY) : null;
if (!stripe) console.warn('[server] STRIPE_SECRET_KEY not set — checkout disabled until configured.');

app.disable('x-powered-by');
app.set('trust proxy', 1);

// -----------------------------------------------------------------------------
// Security headers. Tailwind + cropper.js are vendored/self-hosted, so script
// stays 'self' + Stripe only (no 'unsafe-eval', no third-party script CDN).
// -----------------------------------------------------------------------------
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", 'https://js.stripe.com'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:'], // data:/blob: for cropper + avatar preview
  connectSrc: ["'self'", 'https://api.stripe.com'],
  frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
};
if (IS_PROD) cspDirectives.upgradeInsecureRequests = [];

app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: true, directives: cspDirectives },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
app.use(cors({ origin: true }));

// Stripe webhook needs the raw body — mount BEFORE json().
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

// Larger limit to accept the avatar data URL on checkout. Webhook is unaffected.
app.use(express.json({ limit: '6mb' }));

// Apple Pay domain association + other .well-known files.
app.use(
  '/.well-known',
  express.static(path.join(PUBLIC_DIR, '.well-known'), {
    dotfiles: 'allow',
    setHeaders: (res) => res.setHeader('Content-Type', 'text/plain; charset=utf-8'),
  })
);

// =============================================================================
// Public API
// =============================================================================
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    brand: cfg.BRAND,
    payments: !!stripe,
    printify: printify.isConfigured(),
    printEngine: printEngine.isAvailable(),
    admin: !!process.env.ADMIN_TOKEN,
    time: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    brand: cfg.BRAND,
    currency: cfg.CURRENCY,
    country: cfg.COUNTRY,
    sizes: cfg.SIZES,
    handleMax: cfg.HANDLE_MAX,
    commentMax: cfg.COMMENT_MAX,
    shipping: cfg.SHIPPING,
    paymentsEnabled: !!stripe,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  });
});

// Single-product endpoint.
app.get('/api/product', (req, res) => {
  const product = db.getPublicProduct();
  if (!product) return res.status(500).json({ error: 'Product unavailable.' });
  res.json({ product });
});

// ---- Checkout: mandatory custom schema -> PaymentIntent ---------------------
app.post('/api/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured yet.' });

    const { ok, errors, items } = sanitize.validateCheckout(req.body, db);
    if (!ok) return res.status(400).json({ error: 'Validation failed.', details: errors });

    // Trusted server-side pricing.
    const subtotal = items.reduce((sum, it) => sum + it.unitPrice * it.qty, 0);
    const shipping = subtotal >= cfg.SHIPPING.FREE_THRESHOLD_CENTS ? 0 : cfg.SHIPPING.FLAT_CENTS;
    const amount = subtotal + shipping;

    // Persist line items WITHOUT the base64 avatar; avatars go to disk.
    const storedItems = items.map((it) => ({
      id: it.id,
      title: it.title,
      size: it.size,
      qty: it.qty,
      unitPrice: it.unitPrice,
      currency: it.currency,
      fulfillment_type: 'POD',
      custom: it.custom,
      avatarPath: null,
    }));

    const order = db.createOrder({
      status: STATUS.PENDING,
      amount,
      currency: cfg.CURRENCY,
      items: storedItems,
      email: sanitize.sanitizeText(req.body.email, 120) || null,
      subtotal,
      shipping,
    });

    // Write each avatar to disk, record the path on the line item.
    items.forEach((it, idx) => {
      const fp = path.join(UPLOADS_DIR, `${order.id}-${idx}.png`);
      saveDataUrlPng(it.avatarDataUrl, fp);
      order.items[idx].avatarPath = fp;
    });
    db.updateOrder(order.id, { items: order.items });

    const first = items[0];
    const metadata = {
      order_ref: order.id,
      order_token: order.token,
      item_count: String(items.length),
      custom_handle: first.custom.handle,
      custom_comment: first.custom.comment,
    };

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: cfg.CURRENCY,
      automatic_payment_methods: { enabled: true },
      description: `${cfg.BRAND} order ${order.id}`,
      metadata,
    });
    db.updateOrder(order.id, { paymentIntentId: intent.id });

    return res.json({
      clientSecret: intent.client_secret,
      orderToken: order.token,
      amount,
      currency: cfg.CURRENCY,
      breakdown: { subtotal, shipping },
    });
  } catch (err) {
    console.error('[checkout] error:', err.message);
    return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ---- Self-service tracking --------------------------------------------------
app.get('/api/orders/track/:token', async (req, res) => {
  const order = db.getOrderByToken(String(req.params.token || ''));
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  if (order.printifyOrderIds && order.printifyOrderIds.length && printify.isConfigured()) {
    try {
      const remote = await printify.getOrder(order.printifyOrderIds[0]);
      const shipment = (remote.shipments && remote.shipments[0]) || null;
      if (shipment) {
        const tracking = {
          carrier: shipment.carrier || null,
          number: shipment.number || null,
          url: shipment.url || null,
          status: remote.status || null,
        };
        db.updateOrder(order.id, { tracking, remoteStatus: remote.status });
        order.tracking = tracking;
        order.remoteStatus = remote.status;
      }
    } catch (err) {
      console.warn(`[track] Printify refresh failed for ${order.id}: ${err.message}`);
    }
  }
  return res.json(buildTrackingView(order));
});

// =============================================================================
// Admin verification API (token-gated) — human approval of drafts
// =============================================================================
function adminAuth(req, res, next) {
  const token = process.env.ADMIN_TOKEN || '';
  if (!token) return res.status(503).json({ error: 'Admin API disabled: set ADMIN_TOKEN.' });
  const provided = String(req.get('x-admin-token') || req.query.token || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Unauthorized.' });
  return next();
}

/**
 * Draft queue: orders awaiting human approval (and any quarantined ones),
 * each with the composited print image + avatar + text for side-by-side review
 * before you click "Submit to Production" in the Printify dashboard.
 */
app.get('/api/admin/pending', adminAuth, async (req, res) => {
  const token = encodeURIComponent(String(req.query.token || req.get('x-admin-token') || ''));
  const local = db.listOrdersByStatus([STATUS.AWAITING_APPROVAL, STATUS.QUARANTINED]);

  // Best-effort cross-reference with Printify's own draft-status orders.
  let printifyDraftCount = null;
  if (printify.isConfigured()) {
    try {
      const remote = await printify.listOrders({ limit: 50 });
      printifyDraftCount = (remote.data || []).filter((o) =>
        PRINTIFY.DRAFT_STATUSES.includes(String(o.status || '').toLowerCase())
      ).length;
    } catch (err) {
      console.warn(`[admin] Printify list failed: ${err.message}`);
    }
  }

  const orders = local.map((o) => ({
    orderId: o.id,
    token: o.token,
    status: o.status,
    createdAt: o.createdAt,
    amount: o.amount,
    printifyOrderIds: o.printifyOrderIds || [],
    quarantineReason: o.quarantineReason || null,
    shipping: o.shipping ? { city: o.shipping.city, region: o.shipping.region, country: o.shipping.country } : null,
    lines: (o.items || []).map((it, idx) => ({
      handle: it.custom.handle,
      comment: it.custom.comment,
      size: it.size,
      qty: it.qty,
      avatarUrl: `/api/admin/avatar/${o.id}/${idx}?token=${token}`,
      printUrl: `/api/admin/print/${o.id}/${idx}?token=${token}`,
    })),
  }));

  res.json({ count: orders.length, printifyDraftCount, orders });
});

function serveOrderFile(res, dir, orderId, idx) {
  if (!/^ord_[a-f0-9]+$/.test(orderId) || !/^\d+$/.test(String(idx))) return res.status(400).end();
  const fp = path.join(dir, `${orderId}-${idx}.png`);
  if (!fp.startsWith(dir) || !fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  return fs.createReadStream(fp).pipe(res);
}
app.get('/api/admin/print/:orderId/:idx', adminAuth, (req, res) =>
  serveOrderFile(res, PRINTS_DIR, req.params.orderId, req.params.idx)
);
app.get('/api/admin/avatar/:orderId/:idx', adminAuth, (req, res) =>
  serveOrderFile(res, UPLOADS_DIR, req.params.orderId, req.params.idx)
);

// =============================================================================
// Stripe webhook (unchanged flow; POD-only fulfillment)
// =============================================================================
async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(503).send('Payments not configured.');

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error(`[webhook] signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (db.hasProcessedEvent(event.id)) {
    return res.status(200).json({ received: true, deduped: true });
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      await onPaymentSucceeded(event.data.object);
    }
    db.markEventProcessed(event.id);
  } catch (err) {
    db.markEventProcessed(event.id);
    console.error(`[webhook] handler error for ${event.id}: ${err.message}`);
    await notifyAdmin('Webhook handler error', err.message, { eventId: event.id, type: event.type });
  }
  return res.status(200).json({ received: true });
}

async function onPaymentSucceeded(pi) {
  const order = db.findOrderByPaymentIntent(pi.id);
  if (!order) {
    await notifyAdmin('Paid intent with no local order', pi.id, { amount: pi.amount });
    return;
  }
  if ([STATUS.AWAITING_APPROVAL, STATUS.QUARANTINED].includes(order.status)) return; // already handled

  const shipping = mapStripeShipping(pi);
  const email = order.email || pi.receipt_email || null;
  db.updateOrder(order.id, { status: STATUS.PAID, shipping, email });
  order.status = STATUS.PAID;
  order.shipping = shipping;
  order.email = email;

  fireConversions(order, pi).catch((e) => console.error('[capi] error:', e.message));
  await fulfillOrder(order);
}

// =============================================================================
// Fulfillment (100% POD)
// =============================================================================
async function fulfillOrder(order) {
  const shipping = order.shipping;
  const printifyOrderIds = [];

  if (!shipping) {
    db.updateOrder(order.id, { status: STATUS.FULFILLMENT_FAILED });
    await notifyAdmin('POD missing shipping address', `Order ${order.id}`, { order: order.id });
    return;
  }

  for (let idx = 0; idx < order.items.length; idx++) {
    const item = order.items[idx];
    try {
      const printifyOrderId = await fulfillPodItem(order, item, idx, shipping);
      printifyOrderIds.push(printifyOrderId);
    } catch (err) {
      // Corrupt/unrenderable avatar -> QUARANTINE (do not submit to Printify).
      if (err.quarantine) {
        db.updateOrder(order.id, { status: STATUS.QUARANTINED, quarantineReason: err.message, printifyOrderIds });
        await notifyAdmin('Order QUARANTINED — bad print file', `Order ${order.id}: ${err.message}`, {
          order: order.id,
          item: idx,
        });
        return;
      }
      db.updateOrder(order.id, { status: STATUS.FULFILLMENT_FAILED, fulfillError: err.message, printifyOrderIds });
      await notifyAdmin('Fulfillment failure', `Order ${order.id} item ${idx}: ${err.message}`, { order: order.id });
      return;
    }
  }

  db.updateOrder(order.id, { status: STATUS.AWAITING_APPROVAL, printifyOrderIds });
}

/**
 * Render + upload one custom item, then create a Printify DRAFT (on-hold).
 * Draft is NOT sent to production — an admin approves it after verification.
 * @returns {Promise<string>} printify order id
 */
async function fulfillPodItem(order, item, idx, shipping) {
  const product = db.getProduct(item.id);

  // 300 DPI transparent PNG with circular avatar + word-wrapped comment.
  const png = await printEngine.generatePrintImage({
    handle: item.custom.handle,
    comment: item.custom.comment,
    avatar: item.avatarPath, // validatePrintFile runs inside; throws err.quarantine on bad image
  });

  // Save the composited print for admin side-by-side verification.
  try {
    fs.writeFileSync(path.join(PRINTS_DIR, `${order.id}-${idx}.png`), png.buffer);
  } catch (e) {
    console.warn(`[fulfill] could not persist print preview: ${e.message}`);
  }

  const upload = await printify.uploadImage(`${order.id}-${idx}.png`, png.base64);

  const variantId = product && product.variants ? product.variants[item.size] : undefined;
  if (!variantId) throw new Error(`No Printify variant id mapped for size ${item.size}.`);

  const body = printify.buildLineItemOrder({
    externalId: `${order.id}:${idx}`,
    label: `${cfg.BRAND} ${item.custom.handle}`,
    variantId,
    blueprintId: product.blueprintId,
    printProviderId: product.printProviderId,
    quantity: item.qty,
    imageId: upload.id,
    address: {
      first_name: shipping.first_name || 'Customer',
      last_name: shipping.last_name || '',
      email: order.email || shipping.email || '',
      phone: shipping.phone || '',
      country: shipping.country,
      region: shipping.region,
      address1: shipping.address1,
      address2: shipping.address2,
      city: shipping.city,
      zip: shipping.zip,
    },
  });

  const created = await printify.createOrder(body); // stays on-hold == our DRAFT
  return created.id;
}

// =============================================================================
// Helpers
// =============================================================================
function saveDataUrlPng(dataUrl, filePath) {
  const m = String(dataUrl).match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/);
  if (!m) throw new Error('invalid avatar data URL');
  fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
}

function mapStripeShipping(pi) {
  const s = pi.shipping;
  if (!s || !s.address) return null;
  return sanitize.sanitizeAddress({
    first_name: (s.name || '').split(' ')[0],
    last_name: (s.name || '').split(' ').slice(1).join(' '),
    phone: s.phone,
    email: pi.receipt_email,
    country: s.address.country,
    region: s.address.state,
    city: s.address.city,
    address1: s.address.line1,
    address2: s.address.line2,
    zip: s.address.postal_code,
  });
}

async function fireConversions(order, pi) {
  if (order.capiSent) return;
  const summary = await capi.sendPurchase({
    eventId: pi.id,
    email: order.email,
    phone: order.shipping && order.shipping.phone,
    value: (order.amount / 100).toFixed(2),
    currency: order.currency,
    sourceUrl: PUBLIC_URL,
  });
  db.updateOrder(order.id, { capiSent: true, capiSummary: summary });
}

function buildTrackingView(order) {
  const t = order.tracking || null;
  const shipped = !!(t && t.number);
  const delivered = shipped && /deliver/i.test(t.status || order.remoteStatus || '');
  const paid = order.status !== STATUS.PENDING;
  const inProduction = [STATUS.AWAITING_APPROVAL].includes(order.status) || shipped;

  const milestones = [
    { key: 'ordered', label: 'Order placed', done: true, at: order.createdAt },
    { key: 'paid', label: 'Payment cleared', done: paid, at: paid ? order.updatedAt : null },
    { key: 'production', label: 'In production (custom printed on demand — 3–5 business days)', done: inProduction, at: null },
    { key: 'shipped', label: 'Shipped', done: shipped, at: null },
    { key: 'delivered', label: 'Delivered', done: delivered, at: null },
  ];

  return {
    token: order.token,
    status: order.status,
    placedAt: order.createdAt,
    items: (order.items || []).map((it) => ({
      title: it.title,
      size: it.size,
      qty: it.qty,
      custom: it.custom ? { handle: it.custom.handle, comment: it.custom.comment } : null,
    })),
    milestones,
    tracking: t ? { carrier: t.carrier, number: t.number, url: t.url } : null,
  };
}

// =============================================================================
// Static frontend + errors
// =============================================================================
app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: IS_PROD ? '1h' : 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  return res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`\n  ${cfg.BRAND} running on ${PUBLIC_URL}`);
  console.log(
    `  payments:${!!stripe}  printify:${printify.isConfigured()}  canvas:${printEngine.isAvailable()}  admin:${!!process.env.ADMIN_TOKEN}\n`
  );
});

module.exports = app;
