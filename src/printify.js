'use strict';

/**
 * Printify REST client.
 *
 * Wraps the three calls the fulfillment pipeline needs:
 *   1. uploadImage()      — push the rendered PNG to Printify's media library
 *   2. createOrder()      — create an order (lands "on-hold" == our "Draft")
 *   3. sendToProduction() — release an on-hold order to the printer
 *   4. getOrder()         — poll status/tracking for the /track portal
 *
 * All requests use a short timeout and normalize errors to `Error` objects that
 * carry Printify's response body, so callers can log/alert with real context.
 */

const axios = require('axios');
const { PRINTIFY } = require('./config');

const TOKEN = process.env.PRINTIFY_API_TOKEN || '';
const SHOP_ID = PRINTIFY.SHOP_ID;

const http = axios.create({
  baseURL: PRINTIFY.BASE_URL,
  timeout: 20000,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'QuoteUnquote-Commerce/1.0',
  },
});

function assertConfigured() {
  if (!TOKEN) throw new Error('PRINTIFY_API_TOKEN is not set.');
  if (!SHOP_ID) throw new Error('SHOP_ID is not set.');
}

/** Turn an axios failure into a descriptive Error carrying Printify's payload. */
function normalizeError(err, context) {
  if (err.response) {
    const { status, data } = err.response;
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    const e = new Error(`Printify ${context} failed (HTTP ${status}): ${detail}`);
    e.status = status;
    e.body = data;
    return e;
  }
  if (err.request) {
    return new Error(`Printify ${context} failed: no response (network/timeout).`);
  }
  return new Error(`Printify ${context} failed: ${err.message}`);
}

/**
 * Upload a base64 PNG. Returns the uploaded image record (has `.id`).
 * @param {string} fileName
 * @param {string} base64Contents  raw base64 (no data: prefix)
 */
async function uploadImage(fileName, base64Contents) {
  assertConfigured();
  try {
    const { data } = await http.post('/v1/uploads/images.json', {
      file_name: fileName,
      contents: base64Contents,
    });
    return data; // { id, file_name, height, width, ... }
  } catch (err) {
    throw normalizeError(err, 'image upload');
  }
}

/**
 * Create an order. By default Printify holds it ("on-hold") until you call
 * sendToProduction — that hold IS our "Draft for admin approval" state.
 *
 * @param {object} payload  fully-formed Printify order body
 * @returns {object} created order (has `.id`)
 */
async function createOrder(payload) {
  assertConfigured();
  try {
    const { data } = await http.post(`/v1/shops/${SHOP_ID}/orders.json`, payload);
    return data;
  } catch (err) {
    throw normalizeError(err, 'order create');
  }
}

/** Release an on-hold order to the printer (used for curated/pre-made drops). */
async function sendToProduction(printifyOrderId) {
  assertConfigured();
  try {
    const { data } = await http.post(
      `/v1/shops/${SHOP_ID}/orders/${printifyOrderId}/send_to_production.json`,
      {}
    );
    return data;
  } catch (err) {
    throw normalizeError(err, 'send-to-production');
  }
}

/** Fetch a single order (status + shipments/tracking). */
async function getOrder(printifyOrderId) {
  assertConfigured();
  try {
    const { data } = await http.get(`/v1/shops/${SHOP_ID}/orders/${printifyOrderId}.json`);
    return data;
  } catch (err) {
    throw normalizeError(err, 'order fetch');
  }
}

/** List shop orders (paginated). Used by the admin verification queue. */
async function listOrders({ page = 1, limit = 20 } = {}) {
  assertConfigured();
  try {
    const { data } = await http.get(`/v1/shops/${SHOP_ID}/orders.json`, {
      params: { page, limit },
    });
    return data; // { current_page, last_page, data: [orders...] }
  } catch (err) {
    throw normalizeError(err, 'orders list');
  }
}

/**
 * Build a Printify order body for one line item that carries a custom print.
 *
 * NOTE: The exact `print_areas` shape depends on the blueprint's print
 * placeholders (front/back/etc). Confirm your blueprint via
 *   GET /v1/catalog/blueprints/{id}/print_providers/{pid}/variants.json
 * and adjust `position`/scale as needed. `imageId` is the id returned by
 * uploadImage().
 */
function buildLineItemOrder({ externalId, label, variantId, quantity, imageUrl, address, blueprintId, printProviderId }) {
  return {
    external_id: externalId,
    label: label || externalId,
    line_items: [
      {
        print_provider_id: printProviderId || PRINTIFY.PRINT_PROVIDER_ID,
        blueprint_id: blueprintId || PRINTIFY.BLUEPRINT_ID,
        variant_id: variantId,
        quantity,
        print_areas: {
          front: [
            {
              src: imageUrl, // public URL Printify fetches the artwork from
              scale: 1,
              x: 0.5,
              y: 0.5,
              angle: 0,
            },
          ],
        },
      },
    ],
    shipping_method: PRINTIFY.SHIPPING_METHOD,
    send_shipping_notification: false,
    address_to: address,
  };
}

module.exports = {
  uploadImage,
  createOrder,
  sendToProduction,
  getOrder,
  listOrders,
  buildLineItemOrder,
  isConfigured: () => !!(TOKEN && SHOP_ID),
};
