'use strict';

/**
 * Lightweight JSON-backed data store (100% Custom POD).
 *
 * - products.json is the single-product seed (read on boot).
 * - orders.json + idempotency.json are mutable runtime state (write-through).
 *
 * Writes are atomic (temp file + rename). Fine for a single PaaS instance; for
 * horizontal scale / redeploy-durable state, port to schema.sql (Railway PG).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const IDEMPOTENCY_FILE = path.join(DATA_DIR, 'idempotency.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`[db] Failed to read ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const products = readJson(path.join(DATA_DIR, 'products.json'), []);
let orders = readJson(ORDERS_FILE, []);
let processedEvents = readJson(IDEMPOTENCY_FILE, []);
if (!Array.isArray(orders)) orders = [];
if (!Array.isArray(processedEvents)) processedEvents = [];

const persistOrders = () => writeJsonAtomic(ORDERS_FILE, orders);
const persistIdempotency = () => writeJsonAtomic(IDEMPOTENCY_FILE, processedEvents);

// ---------------------------------------------------------------------------
// Products (single custom product)
// ---------------------------------------------------------------------------
function getProduct(id) {
  return products.find((p) => p.id === id) || null;
}

/** The one product. Client-safe projection (no internal Printify ids). */
function getPublicProduct() {
  const p = products.find((x) => x.custom) || products[0] || null;
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    color: p.color,
    blank: p.blank,
    price: p.price,
    currency: p.currency,
    image: p.image,
    description: p.description,
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
function createOrder(order) {
  const now = new Date().toISOString();
  const record = {
    id: `ord_${crypto.randomBytes(9).toString('hex')}`,
    token: `trk_${crypto.randomBytes(12).toString('hex')}`,
    status: 'pending',
    paymentIntentId: null,
    printifyOrderIds: [],
    tracking: null,
    shipping: null,
    email: null,
    capiSent: false,
    createdAt: now,
    updatedAt: now,
    ...order,
  };
  orders.push(record);
  persistOrders();
  return record;
}

function updateOrder(id, patch) {
  const idx = orders.findIndex((o) => o.id === id);
  if (idx === -1) return null;
  orders[idx] = { ...orders[idx], ...patch, updatedAt: new Date().toISOString() };
  persistOrders();
  return orders[idx];
}

function getOrder(id) {
  return orders.find((o) => o.id === id) || null;
}

function getOrderByToken(token) {
  return orders.find((o) => o.token === token) || null;
}

function findOrderByPaymentIntent(paymentIntentId) {
  return orders.find((o) => o.paymentIntentId === paymentIntentId) || null;
}

/** Orders whose status is in `statuses` (newest first). For the admin queue. */
function listOrdersByStatus(statuses) {
  const set = new Set(statuses);
  return orders
    .filter((o) => set.has(o.status))
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ---------------------------------------------------------------------------
// Idempotency ledger (webhook de-dup)
// ---------------------------------------------------------------------------
function hasProcessedEvent(eventId) {
  return processedEvents.includes(eventId);
}

function markEventProcessed(eventId) {
  if (!processedEvents.includes(eventId)) {
    processedEvents.push(eventId);
    if (processedEvents.length > 5000) processedEvents = processedEvents.slice(-5000);
    persistIdempotency();
  }
}

module.exports = {
  getProduct,
  getPublicProduct,
  createOrder,
  updateOrder,
  getOrder,
  getOrderByToken,
  findOrderByPaymentIntent,
  listOrdersByStatus,
  hasProcessedEvent,
  markEventProcessed,
};
