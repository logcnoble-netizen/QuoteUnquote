# TikTok Business API — setup steps

Verified 2026-07-25 via TikTok's official token-generation flow and
cross-checked across independent sources. Unlike Meta, **TikTok does not
have a "managing your own account = no review" exception** — production
access to the Marketing API requires app review regardless of whose ad
account you're touching. The Events API (server-side conversions) is the
one exception: its token is generated directly in Ads Manager's own UI with
no review step.

## Part 1 — Events API / CAPI (self-serve, do this first)

This lights up `sendTikTok()` in `src/capi.js`, which already exists and
sends a hashed-PII `CompletePayment` event the moment a Stripe payment
clears.

1. [ads.tiktok.com](https://ads.tiktok.com) → **Assets** → **Web Events**.
2. Select (or create) your Pixel.
3. **Settings** → **Generate Access Token**. Copy it immediately — like
   most of these, it's typically shown once.
4. Note your **Pixel ID** from the same page.

### Hand to Claude (via Railway env vars, never in chat)

- `TIKTOK_PIXEL_ID`
- `TIKTOK_CAPI_TOKEN`

Once set, tell me and I'll verify a test purchase lands in TikTok's
event-testing tool (Ads Manager → Assets → Web Events → your Pixel →
Test Events).

## Part 2 — Marketing API (reporting + campaign management, needs review)

This is the part that lets Claude read campaign performance and, later,
propose budget/campaign changes.

1. [business-api.tiktok.com/portal](https://business-api.tiktok.com/portal)
   → register as a developer, create an app. You'll get a `client_key` and
   `client_secret`.
2. Complete **Business Center** onboarding / **business verification** if
   not already done — TikTok's review checks this.
3. Build the OAuth authorization flow (same shape as any OAuth app: an
   authorize URL, a redirect that exchanges the code for tokens) — this
   needs to actually work before you submit, since review tests it live in
   the sandbox first.
4. **Submit for review.** Expect TikTok to check:
   - The OAuth flow completes correctly end-to-end
   - Data-security/privacy compliance (what you store, how, your privacy
     policy covers it)
   - The stated use case matches what the app actually does
   - Business verification status
5. Typical turnaround **3–7 days**, per multiple independent reports —
   this isn't an official TikTok-published SLA, so treat it as a planning
   estimate, not a guarantee.
6. On approval, exchange for an advertiser-authorized access token
   (TikTok's tokens are shorter-lived than Meta's System User tokens —
   access tokens are short-lived, refresh tokens last up to 60 days, so
   the integration needs a refresh step Meta's setup doesn't).

### Hand to Claude once approved (via Railway env vars)

- `TIKTOK_ADS_ADVERTISER_ID`
- `TIKTOK_ADS_ACCESS_TOKEN`
- `TIKTOK_ADS_REFRESH_TOKEN` (needed — unlike Meta's System User token,
  this one expires and must be refreshed)

## What I'll build once each part lands

- **Part 1 alone**: nothing new to build — it's flipping on existing code.
  I'll just verify it fires.
- **Part 2 approved**: read path (spend/CPA/ROAS dashboard) and write path
  (propose-then-approve budget/campaign changes, per the guardrail model in
  `AGENT_SCOPE.md`) against the
  [TikTok Marketing API](https://business-api.tiktok.com/portal/docs).

## Before you submit for review — worth deciding together

Review asks you to state a use case. Since I'll draft the OAuth
implementation, I should be involved before you submit so the stated scope
matches what actually gets built (e.g. "read campaign performance and
manage budgets for our own advertiser account" — not overclaiming
permissions we don't need, which the search results flagged as something
that itself slows down approval).
