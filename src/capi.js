'use strict';

/**
 * Server-side ad attribution (Conversions API).
 *
 * Fires Purchase events straight to Meta and TikTok the moment a payment
 * clears — server-to-server, so it survives ad blockers and iOS tracking
 * limits. PII (email/phone) is SHA-256 hashed per both platforms' specs before
 * it ever leaves the box. Both calls are best-effort: failures are logged and
 * surfaced to the admin alert, never allowed to break fulfillment.
 */

const axios = require('axios');
const crypto = require('crypto');

const PUBLIC_URL = process.env.PUBLIC_URL || '';

const sha256 = (v) =>
  crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

const normPhone = (v) => String(v || '').replace(/[^0-9]/g, '');

/** Meta Conversions API — Purchase. */
async function sendMeta({ eventId, email, phone, value, currency, sourceUrl }) {
  const pixel = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixel || !token) return { skipped: 'meta_not_configured' };

  const userData = {};
  if (email) userData.em = [sha256(email)];
  if (phone) userData.ph = [sha256(normPhone(phone))];

  const body = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId, // dedup key shared with the browser pixel
        action_source: 'website',
        event_source_url: sourceUrl || PUBLIC_URL,
        user_data: userData,
        custom_data: { currency: String(currency).toUpperCase(), value: Number(value) },
      },
    ],
  };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/v19.0/${pixel}/events?access_token=${encodeURIComponent(token)}`;
  const { data } = await axios.post(url, body, { timeout: 8000 });
  return data;
}

/** TikTok Events API — CompletePayment. */
async function sendTikTok({ eventId, email, phone, value, currency, sourceUrl }) {
  const pixel = process.env.TIKTOK_PIXEL_ID;
  const token = process.env.TIKTOK_CAPI_TOKEN;
  if (!pixel || !token) return { skipped: 'tiktok_not_configured' };

  const body = {
    event_source: 'web',
    event_source_id: pixel,
    data: [
      {
        event: 'CompletePayment',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        user: {
          ...(email ? { email: sha256(email) } : {}),
          ...(phone ? { phone: sha256(normPhone(phone)) } : {}),
        },
        page: { url: sourceUrl || PUBLIC_URL },
        properties: { currency: String(currency).toUpperCase(), value: Number(value) },
      },
    ],
  };

  const { data } = await axios.post(
    'https://business-api.tiktok.com/open_api/v1.3/event/track/',
    body,
    { timeout: 8000, headers: { 'Access-Token': token, 'Content-Type': 'application/json' } }
  );
  return data;
}

/**
 * Fire both platforms concurrently. Never throws — returns a per-platform
 * result summary so the caller can log it. Use the SAME eventId as the
 * browser-side pixel to deduplicate.
 */
async function sendPurchase(params) {
  const results = await Promise.allSettled([sendMeta(params), sendTikTok(params)]);
  const summary = {
    meta: results[0].status === 'fulfilled' ? results[0].value : { error: results[0].reason?.message },
    tiktok: results[1].status === 'fulfilled' ? results[1].value : { error: results[1].reason?.message },
  };
  return summary;
}

module.exports = { sendPurchase, sendMeta, sendTikTok };
