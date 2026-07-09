'use strict';

/**
 * Input sanitation + validation for the checkout endpoint (100% Custom POD).
 * Every line item MUST carry a handle, a comment, and an avatar data URL — the
 * client caps are UX; this is the authoritative gate. Missing/invalid fields
 * make validateCheckout return ok:false, which the route surfaces as 400.
 */

const { HANDLE_MAX, COMMENT_MAX, SIZES, MAX_QTY_PER_LINE, AVATAR } = require('./config');

// ASCII control chars (0x00-0x1F, 0x7F), built from escapes so no literal
// control bytes live in this source file.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

function stripTags(str) {
  return String(str).replace(/<\/?[^>]*>/g, '');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function sanitizeText(value, max) {
  let s = String(value == null ? '' : value);
  s = s.replace(CONTROL_CHARS, ' ');
  s = stripTags(s);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Shallow structural check of an avatar data URL. Full decode/corruption
 * detection happens later in printEngine.validatePrintFile at render time.
 * @returns {{ok:boolean, reason?:string, mime?:string}}
 */
function validateAvatarDataUrl(value) {
  if (typeof value !== 'string' || !value) return { ok: false, reason: 'avatar image is required' };
  if (value.length > AVATAR.MAX_DATAURL_CHARS) return { ok: false, reason: 'avatar image is too large' };
  const m = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/=\s]+$/);
  if (!m) return { ok: false, reason: 'avatar must be a base64 image data URL' };
  const mime = m[1].toLowerCase();
  if (!AVATAR.ALLOWED_MIME.includes(mime)) return { ok: false, reason: `unsupported avatar type ${mime}` };
  return { ok: true, mime };
}

/**
 * Validate the checkout payload against the trusted catalog. Every item is a
 * custom POD tee and must have handle + comment + avatarDataUrl.
 *
 * @param {object} body     raw request body
 * @param {object} catalog  db module (getProduct)
 * @returns {{ok:boolean, errors:string[], items:object[]}}
 */
function validateCheckout(body, catalog) {
  const errors = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ['Malformed request body.'], items: [] };
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) errors.push('Cart is empty.');
  if (rawItems.length > 25) errors.push('Too many line items.');

  const items = [];

  rawItems.forEach((raw, i) => {
    const n = i + 1;
    if (!isPlainObject(raw)) { errors.push(`Line ${n}: malformed.`); return; }

    const product = catalog.getProduct(String(raw.id || ''));
    if (!product || !product.custom) {
      errors.push(`Line ${n}: not a valid custom product.`);
      return;
    }

    const size = String(raw.size || '').toUpperCase();
    if (!SIZES.includes(size)) { errors.push(`Line ${n}: invalid size "${raw.size}".`); return; }

    let qty = Math.floor(Number(raw.qty));
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > MAX_QTY_PER_LINE) qty = MAX_QTY_PER_LINE;

    // Mandatory custom schema.
    const custom = isPlainObject(raw.custom) ? raw.custom : {};
    const handle = sanitizeText(custom.handle, HANDLE_MAX);
    const comment = sanitizeText(custom.comment, COMMENT_MAX);
    if (!handle) errors.push(`Line ${n}: handle is required.`);
    if (!comment) errors.push(`Line ${n}: comment is required.`);

    const avatar = validateAvatarDataUrl(raw.avatarDataUrl);
    if (!avatar.ok) errors.push(`Line ${n}: ${avatar.reason}.`);

    const normHandle = handle.startsWith('@') ? handle : `@${handle}`;
    items.push({
      id: product.id,
      title: product.title,
      size,
      qty,
      unitPrice: product.price,
      currency: product.currency,
      fulfillment_type: 'POD',
      custom: { handle: normHandle.slice(0, HANDLE_MAX), comment },
      avatarDataUrl: avatar.ok ? raw.avatarDataUrl : null, // persisted to disk by the route
    });
  });

  // Legal waiver remains mandatory for all (now exclusively custom) orders.
  if (body.waiverAccepted !== true) {
    errors.push('You must accept the custom-text IP & indemnity waiver to continue.');
  }

  return { ok: errors.length === 0, errors, items };
}

/** Validate a shipping address captured from the wallet/card sheet. */
function sanitizeAddress(addr) {
  if (!isPlainObject(addr)) return null;
  const field = (v, max = 100) => sanitizeText(v, max);
  const clean = {
    first_name: field(addr.first_name || addr.firstName, 60),
    last_name: field(addr.last_name || addr.lastName, 60),
    email: field(addr.email, 120),
    phone: field(addr.phone, 40),
    country: field(addr.country, 2).toUpperCase(),
    region: field(addr.region || addr.state, 60),
    city: field(addr.city, 80),
    address1: field(addr.address1 || addr.line1, 120),
    address2: field(addr.address2 || addr.line2, 120),
    zip: field(addr.zip || addr.postal_code || addr.postalCode, 20),
  };
  if (!clean.address1 || !clean.city || !clean.country || !clean.zip) return null;
  return clean;
}

module.exports = {
  stripTags,
  escapeHtml,
  sanitizeText,
  validateAvatarDataUrl,
  validateCheckout,
  sanitizeAddress,
};
