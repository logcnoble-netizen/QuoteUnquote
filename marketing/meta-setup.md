# Meta Marketing API — setup steps (Standard Access, no App Review)

Verified against Meta's current docs 2026-07-25: this app only ever manages
the QuoteUnquote-owned ad account, so it qualifies for **Standard Access**,
which is auto-approved — no App Review, no screencast, no waiting. (Advanced
Access / App Review is only required for third-party apps managing *other
people's* ad accounts, which doesn't apply here.)

## Steps (do these in the Meta dashboard, not in chat)

1. **Business verification** — [business.facebook.com](https://business.facebook.com)
   → Business Settings → Security Center → Start Verification, if not
   already verified. This is Meta confirming *you* run a real business, not
   a per-app review.
2. **Create the app** — [developers.facebook.com](https://developers.facebook.com)
   → My Apps → Create App → type **Business**. Add the **Marketing API**
   product to it.
3. **Create a System User** — Business Settings → Users → System Users →
   Add. Assign it as **Admin** (or a scoped Employee role with the ad
   account assigned) on your ad account.
4. **Generate a System User access token** — on that System User, generate
   a token with scopes `ads_read` and `ads_management`. System User tokens
   don't expire on the normal 60-day user-token clock the way personal
   tokens do, which matters for a server-side integration that shouldn't
   need re-auth every two months.
5. **Note the Ad Account ID** — Business Settings → Accounts → Ad Accounts;
   it looks like `act_1234567890`.

## What to hand to Claude (via Railway env vars, never in chat)

- `META_ADS_ACCOUNT_ID` — the `act_...` id
- `META_ADS_ACCESS_TOKEN` — the System User token from step 4

Once those exist in Railway, the reporting integration can be built against
the [Insights API](https://developers.facebook.com/docs/marketing-api/insights)
for the read path, and the
[Campaign/AdSet/Ad Set Budget endpoints](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group)
for the write path — gated by the propose-then-approve flow in
`AGENT_SCOPE.md`, not by anything Meta enforces.

## Note on the CAPI token vs. this token

These are two different credentials for two different things — don't
conflate them:

- `META_CAPI_TOKEN` (already referenced in `src/capi.js`) — a Conversions
  API token tied to your **Pixel**, used to *send* purchase events *to*
  Meta for ad optimization/attribution.
- `META_ADS_ACCESS_TOKEN` (this doc) — a Marketing API token tied to your
  **ad account**, used to *read/write campaign data* — spend, budgets,
  performance.

You'll eventually want both set, but they're independent and can be set up
in either order.
