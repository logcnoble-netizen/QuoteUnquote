'use strict';

/**
 * Shared constants. Frontend caps are mirrored here so the server can
 * re-validate everything it receives — client caps are UX; these are the gate.
 *
 * ARCHITECTURE: 100% Custom Print-On-Demand. There is no bulk/curated path.
 * Every order carries a handle, a comment, and a user-cropped circular avatar.
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

module.exports = {
  BRAND: 'QuoteUnquote',

  // Hard input limits (must match public/app.js + index.html maxlength attrs).
  // HANDLE_MAX counts typed characters WITHOUT the "@" we prepend. Handles
  // longer than ~15 chars still render on ONE line — the print engine and
  // preview auto-shrink the handle font to fit (floor at half the base size).
  HANDLE_MAX: 30,
  COMMENT_MAX: 150,
  // "Time since posted" string, e.g. "2h", "1 week", "36 min".
  TIME_MAX: 8,
  TIME_DEFAULT: '2h',

  SIZES: ['S', 'M', 'L', 'XL', '2XL', '3XL'],
  COLORS: ['Black', 'White'],
  MAX_QTY_PER_LINE: 10,
  CURRENCY: 'usd',
  COUNTRY: 'US',

  // The single product. Priced server-side; the client never sets amounts.
  PRODUCT_ID: 'custom-comment',

  SHIPPING: {
    FLAT_CENTS: 600,
    FREE_THRESHOLD_CENTS: 9000,
  },

  // High-resolution print-file geometry. 3600 x 4200 px @ 300 DPI (12in x 14in).
  PRINT: {
    DPI: 300,
    WIDTH_PX: 3600,
    HEIGHT_PX: 4200,
  },

  // User-uploaded avatar constraints (validated in sanitize + printEngine).
  AVATAR: {
    // Max decoded-ish size guard on the incoming data URL string length.
    MAX_DATAURL_CHARS: 3_000_000, // ~2.2 MB binary
    ALLOWED_MIME: ['image/png', 'image/jpeg', 'image/webp'],
    // Minimum acceptable decoded dimensions — anything smaller is "corrupt".
    MIN_DIMENSION: 64,
  },

  PRINTIFY: {
    BASE_URL: 'https://api.printify.com',
    SHOP_ID: process.env.SHOP_ID || '',
    PRINT_PROVIDER_ID: num(process.env.PRINTIFY_PRINT_PROVIDER_ID, 0),
    BLUEPRINT_ID: num(process.env.PRINTIFY_BLUEPRINT_ID, 0),
    SHIPPING_METHOD: 1,
    // Printify statuses that represent an un-produced draft awaiting approval.
    DRAFT_STATUSES: ['on-hold', 'draft', 'pending'],
  },

  // Internal order lifecycle.
  STATUS: {
    PENDING: 'pending',
    PAID: 'paid',
    AWAITING_APPROVAL: 'awaiting_approval', // Printify draft created, on-hold
    QUARANTINED: 'quarantined',             // print/validation failed, held for admin
    FULFILLMENT_FAILED: 'fulfillment_failed',
  },
};
