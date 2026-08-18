# QuoteUnquote Marketing Agent — Scope

Status: **planning**. Nothing in this doc is built yet except where noted.
Last updated: 2026-07-25.

## Why this exists

The goal is a marketing/advertising workflow that can (a) report on ad
performance across Meta, and later TikTok/Google, and (b) eventually propose
and — with explicit approval — execute campaign changes. There is no
off-the-shelf "Ads MCP" for any of these platforms (checked the plugin
catalog and MCP registry — nothing exists as of this writing), so this is a
custom integration against each platform's REST API, the same pattern already
used for Stripe and Printify in this codebase.

## Sequencing (decided 2026-07-25: TikTok is priority #1)

1. **TikTok Events API (server-side conversions)** — turn on code that
   already exists (`src/capi.js`, `sendTikTok`), no new build. Token is
   generated self-serve inside TikTok Ads Manager (Assets → Web Events →
   Pixel → Settings → Generate Access Token) — **no app review**, this is
   an in-product action. Blocking on: `TIKTOK_PIXEL_ID` +
   `TIKTOK_CAPI_TOKEN` in Railway. Setup steps in `marketing/tiktok-setup.md`.
2. **TikTok Marketing API (reporting + campaign management)** — unlike
   Meta, TikTok requires app review for this **even when you only manage
   your own ad account** — there's no Standard-Access-style exception.
   Review covers OAuth flow correctness, data-security/privacy compliance,
   and business verification; typically 3–7 days. Read (reporting) and
   write (budgets/campaigns) go through the same reviewed app — TikTok
   doesn't split them the way Meta splits `ads_read`/`ads_management`, so
   there's no way to ship a review-free reporting dashboard first the way
   there was with Meta. Steps in `marketing/tiktok-setup.md`.
3. **Meta** — CAPI + Marketing API groundwork already scoped in
   `marketing/meta-setup.md` (Standard Access, no review needed there).
   Picked back up after TikTok.
4. **Google Ads** — deferred until TikTok + Meta are proven out.

## Guardrail model (decided)

**Hard budget cap + always-ask.** Specifically:

- The account owner sets a daily/monthly spend cap directly in Meta Ads
  Manager as a backstop that exists independent of anything Claude does.
- Claude never creates, pauses, or changes budgets on a live campaign
  without proposing the specific change (what, why, expected effect) and
  getting explicit approval in chat first.
- Read-only reporting (pulling spend/CPA/ROAS numbers) requires no approval
  — it's informational only, nothing changes.
- This mirrors how this codebase already treats other financial actions
  (Stripe refunds, Printify order cancellation): propose, confirm, then act.

## What "done" looks like for v1 (TikTok only)

- [ ] `TIKTOK_PIXEL_ID` / `TIKTOK_CAPI_TOKEN` set in Railway; a real test
      purchase shows up in TikTok Events Manager's event-testing tool.
- [ ] TikTok developer app created, submitted for review, approved (3–7
      days typical) — see `marketing/tiktok-setup.md` for the checklist
      review actually evaluates.
- [ ] Read path built: pull a performance summary (spend, impressions,
      CPA, ROAS, top/bottom campaigns) into some dashboard surface —
      likely an artifact refreshed on request, or a new /admin tab, TBD.
- [ ] Write path built: Claude can propose a budget/campaign change that
      the owner approves in-chat before it's executed via the API. The
      approved app already carries both read+write scope — the
      propose-then-approve software gate is what limits it, not TikTok's
      permission system.

## What "done" looks like for v2 (Meta, picked back up after TikTok)

- [ ] `META_PIXEL_ID` / `META_CAPI_TOKEN` set in Railway; a real test
      purchase shows up in Meta Events Manager's test-events tool.
- [ ] A Meta Business App + System User token exists with `ads_read` +
      `ads_management` (Standard Access — no App Review needed since this
      only ever manages the QuoteUnquote-owned ad account; see
      `marketing/meta-setup.md`).
- [ ] Read + write paths built, same shape as TikTok's above.

## Explicitly out of scope for now

- TikTok Ads API, Google Ads API integration.
- Autonomous campaign creation or spend changes without per-action approval.
- Any write action taken from anything other than an explicit, current-turn
  approval — no standing "always allow" for spend-affecting calls.

## Open questions to revisit

- Where should the reporting dashboard live? (ephemeral artifact vs. a
  persisted /admin tab with real auth, given ad spend numbers are sensitive)
- Reporting refresh cadence — on-demand only, or a scheduled daily pull?
- Attribution window / how ROAS is computed (platform-reported vs. our own
  order data joined by UTM or CAPI event_id) — matters once real budget
  decisions start leaning on this data.
