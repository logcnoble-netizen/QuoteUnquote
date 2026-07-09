'use strict';

/**
 * Admin alerting for fulfillment failure fallbacks.
 *
 * Primary channel is a Discord incoming webhook (zero extra deps, just axios).
 * If it isn't configured, alerts fall back to stderr so nothing is ever
 * silently swallowed. Never throws — alerting must not crash the webhook.
 */

const axios = require('axios');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ops@quoteunquote.example';

/**
 * @param {string} subject  short headline
 * @param {string} message  human-readable detail
 * @param {object} [meta]   structured context (order id, error, etc.)
 */
async function notifyAdmin(subject, message, meta = {}) {
  const line = `[QuoteUnquote ALERT] ${subject} — ${message}`;
  // Always log locally.
  console.error(line, Object.keys(meta).length ? meta : '');

  if (!DISCORD_WEBHOOK_URL) {
    console.error(`[notify] No DISCORD_WEBHOOK_URL set. Would have emailed ${ADMIN_EMAIL}.`);
    return { delivered: false, channel: 'stderr' };
  }

  try {
    const fields = Object.entries(meta)
      .slice(0, 20)
      .map(([name, value]) => ({
        name: String(name).slice(0, 240),
        value: '```' + String(typeof value === 'object' ? JSON.stringify(value) : value).slice(0, 900) + '```',
        inline: false,
      }));

    await axios.post(
      DISCORD_WEBHOOK_URL,
      {
        username: 'QuoteUnquote Ops',
        embeds: [
          {
            title: `🚨 ${subject}`.slice(0, 256),
            description: String(message).slice(0, 2000),
            color: 0x000000,
            fields,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      { timeout: 8000 }
    );
    return { delivered: true, channel: 'discord' };
  } catch (err) {
    console.error(`[notify] Discord delivery failed: ${err.message}`);
    return { delivered: false, channel: 'discord', error: err.message };
  }
}

module.exports = { notifyAdmin };
