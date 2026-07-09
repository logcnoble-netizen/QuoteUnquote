# QuoteUnquote — Custom Comment Tees

A **100% custom Print-On-Demand** streetwear shop: one product, the *"Build Your
Own Comment Tee."* Every order is a made-to-order tee carrying the customer's
**handle + comment + a self-cropped circular avatar**, printed at 300 DPI on a
7.5oz Shaka Wear Max Heavyweight blank. No inventory, no bulk, no curated SKUs.

- **Frontend** — vanilla HTML5 + CSS3 (sleek dark theme) + compiled Tailwind +
  ES6. Live Instagram-comment mockup, **cropper.js** avatar upload/crop, slide-out
  cart, Stripe wallet checkout. Zero build step at runtime.
- **Backend** — Node/Express. Mandatory custom schema, server-side pricing,
  a `canvas` 300 DPI renderer that **composites the circular avatar + wrapped
  comment**, an idempotent Stripe webhook, **Printify draft** orders held for
  human approval, a **quarantine** path for corrupt uploads, a token-gated
  **admin verification** API, Meta + TikTok CAPI, and order tracking.

Built to `git push` straight to **Railway**.

---

## Refactor map (hybrid → 100% Custom POD)

| Objective | Where |
|---|---|
| Removed inventory/bulk/curated logic | `server.js`, `public/app.js`, `src/db.js`, `data/products.json` (single product) |
| Mandatory custom schema (`handle`+`comment`+`avatarDataUrl`) → 400 | `src/sanitize.js`, `POST /api/checkout` |
| Circular avatar clip/mask on **every** order | `src/printEngine.js` `generatePrintImage()` |
| Front-end upload/crop/scale into a circle | `public/index.html` (crop modal), `public/app.js` (cropper.js) |
| Corrupt/unrenderable image → **quarantine** + admin alert | `src/printEngine.js` `validatePrintFile()`, `server.js` `fulfillOrder()` |
| Hardened admin verification queue | `GET /api/admin/pending` (token-gated), `src/printify.js` `listOrders()` |
| Single-product UI (no dropdowns/radios) | `public/index.html`, `public/app.js` |
| High-res canvas (3600×4200 @ 300 DPI) + text wrap | `src/config.js` `PRINT`, `src/printEngine.js` `wrapText()` |
| Untouched: Stripe webhook, Printify draft payload, Railway config | `server.js`, `src/printify.js`, `nixpacks.toml` |

---

## How a design becomes a Printify print file (the backend pipeline)

This is the exact path from a customer's "build your own" template to a file
Printify can produce and ship:

1. **Client crop (browser).** In `app.js`, the uploaded photo is opened in
   **cropper.js** (`aspectRatio: 1`, circular guide). On *Apply*, we call
   `getCroppedCanvas({width:448,height:448})`, then draw that square into a
   canvas with a circular `arc()` clip and export **`toDataURL('image/png')`** —
   a circular, transparent-cornered PNG data URL. That's the `avatarDataUrl`.

2. **Checkout (`POST /api/checkout`).** `sanitize.validateCheckout()` requires
   `handle`, `comment`, and a well-formed `avatarDataUrl` on every line (else
   **400**). The price is taken from `data/products.json` server-side. We create a
   `pending` order, **write each avatar to disk** (`data/uploads/{orderId}-{i}.png`
   — kept out of the JSON store to avoid base64 bloat), and create a Stripe
   **PaymentIntent** with the handle/comment in metadata.

3. **Payment clears (`POST /api/webhooks/stripe`).** Signature verified,
   de-duped on event id **and** order status. The order is marked `paid`, CAPI
   fires, then fulfillment runs.

4. **Render (`printEngine.generatePrintImage`).** For each line item:
   - `validatePrintFile()` decodes the saved avatar with `canvas.loadImage()`.
     If it can't decode, is too small, or is the wrong type, it throws
     `err.quarantine = true` → the order is set **`quarantined`** and the admin is
     alerted. Nothing bad ships.
   - Otherwise we allocate a **3600×4200 @ 300 DPI** transparent canvas, draw the
     avatar inside a circular clip (`arc()` + `clip()`, cover-fit), then the
     **bold white handle**, a red "liked" heart, the **word-wrapped** comment
     (`wrapText()` measures each word and hard-breaks over-long tokens so nothing
     bleeds past the print box), and the grey meta row. Output is a PNG `Buffer`.
   - The composited PNG is also saved to `data/prints/{orderId}-{i}.png` for admin
     side-by-side review.

5. **Upload + draft order (`printify.js`).** The PNG (base64) is pushed via
   `POST /v1/uploads/images.json`; the returned image id is referenced in the
   `print_areas` of a `POST /v1/shops/{shop_id}/orders.json` order for the mapped
   `variant_id`. Printify holds it **on-hold (our "Draft")** — it is **not** sent
   to production automatically. Order status → **`awaiting_approval`**.

6. **Human approval.** You review the queue via `GET /api/admin/pending`
   (or the Printify dashboard) and click **Submit to Production** yourself.

> To actually deliver, fill the real Printify `variants` (size → variant id),
> `PRINTIFY_BLUEPRINT_ID`, and `PRINTIFY_PRINT_PROVIDER_ID` (Ink Blot). The
> `print_areas` shape may need per-blueprint tweaks — see `printify.js`.

---

## Admin verification API (token-gated)

Set `ADMIN_TOKEN` to a long random string (routes return **503** until you do).
Authenticate with `?token=…` or an `x-admin-token` header.

There's a ready-made UI at **`/admin`** (`public/admin.html`): paste your
`ADMIN_TOKEN`, and it renders each pending order's **avatar + composited print +
text side-by-side**, flags quarantined orders in red, and links out to Printify
where you click *Submit to Production*. It's a static page — useless without the
token, which the API validates.

- `GET /api/admin/pending` — orders in `awaiting_approval` / `quarantined`, each
  with handle, comment, size, qty, a `quarantineReason`, and **`avatarUrl` +
  `printUrl`** (admin-only image endpoints) for side-by-side verification.
- `GET /api/admin/print/:orderId/:idx` · `GET /api/admin/avatar/:orderId/:idx` —
  serve the composited print / uploaded avatar (path-traversal guarded).

---

## File tree

```
quoteunquote/
├─ server.js                 Express: checkout, webhook, POD fulfillment, admin
├─ package.json              scripts + deps
├─ .env.example              environment variables (copy → .env)
├─ nixpacks.toml             Railway build: native libs for node-canvas
├─ railway.json              Railway deploy config + healthcheck
├─ schema.sql                optional Postgres schema
├─ tailwind.config.js / tailwind.input.css   compiled Tailwind source
├─ src/
│  ├─ config.js              constants (caps, sizes, 3600×4200 print, avatar)
│  ├─ db.js                  JSON store (single product + orders + idempotency)
│  ├─ sanitize.js            mandatory-schema validation + XSS scrub + waiver
│  ├─ printEngine.js         generatePrintImage() + validatePrintFile() + wrapText()
│  ├─ printify.js            Printify REST client (upload/order/list/track)
│  ├─ capi.js                Meta + TikTok Conversions API
│  └─ notify.js              Discord/stderr admin alerting
├─ data/
│  ├─ products.json          the single custom product (price + variant map)
│  ├─ uploads/               (generated) customer avatars, transient
│  └─ prints/                (generated) composited print previews for admin
└─ public/
   ├─ index.html app.js styles.css tailwind.css   (tailwind.css is generated)
   ├─ vendor/cropper.min.js  cropper.min.css       (vendored, CSP-safe)
   ├─ track.html track.js
   ├─ privacy.html terms.html shipping.html
   └─ .well-known/apple-developer-merchantid-domain-association
```

---

## Quick start (local)

Prereqs: **Node 18.18–20** (canvas ships prebuilt binaries for these).

```bash
npm install          # installs express, stripe, canvas, …
cp .env.example .env # fill in Stripe test keys + ADMIN_TOKEN
npm start            # http://localhost:3000
```

> **Styling / vendored libs.** Tailwind is precompiled to `public/tailwind.css`
> (`npm run build:css` to regenerate). cropper.js is vendored under
> `public/vendor/` so the CSP stays `script-src 'self' https://js.stripe.com`
> (no third-party script CDN, no `'unsafe-eval'`).

The storefront works immediately with no keys. Checkout returns `503` until
`STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` are set.

> **node-canvas note.** Prebuilt binaries install with no setup on macOS/Linux
> and Windows Node ≤20. The web server still boots if canvas is missing — only
> print rendering is disabled, and any render failure is caught and quarantined.

### Testing the Stripe webhook locally

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# copy the whsec_… into STRIPE_WEBHOOK_SECRET, then:
stripe trigger payment_intent.succeeded
```

---

## Deploying to Railway

1. Push to GitHub, create a Railway project from the repo. `nixpacks.toml`
   installs the Cairo/Pango libs node-canvas needs; `railway.json` sets the start
   command + `/api/health` healthcheck.
2. In **Variables**, add everything from `.env.example`. Railway sets `PORT`
   automatically. Set `PUBLIC_URL`, `NODE_ENV=production`, and a strong
   `ADMIN_TOKEN`.
3. Stripe webhook → `https://YOUR-DOMAIN/api/webhooks/stripe`
   (`payment_intent.succeeded`); paste the secret into `STRIPE_WEBHOOK_SECRET`.
4. **Apple Pay:** register the domain in Stripe and replace the `.well-known`
   association file.
5. **Printify:** set the token/shop/blueprint/provider and the real `variants`
   in `data/products.json`.

> **Durability.** `data/` (orders + generated avatars/prints) lives on the
> container filesystem, which Railway resets on redeploy. Attach a Railway
> **Volume** at `/app/data`, or migrate orders to Postgres via `schema.sql`.
> Avatars/prints are transient — once uploaded to Printify they're no longer
> needed locally. A retention sweeper (`src/cleanup.js`) prunes them after
> `CLEANUP_TTL_HOURS` (default 7 days — long enough for admin verification).

---

## Security notes

- Secret keys (`STRIPE_SECRET_KEY`, `PRINTIFY_API_TOKEN`, `ADMIN_TOKEN`) are read
  only server-side. Only the Stripe **publishable** key reaches the client.
- Prices come from `data/products.json` server-side — never the client.
- `handle` + `comment` + address pass through `src/sanitize.js` (tag/control-char
  stripping, length clamps); the avatar is structurally validated at checkout and
  fully decoded/validated at render (`validatePrintFile`).
- Admin routes require a constant-time `ADMIN_TOKEN` match and are **disabled by
  default** (503) when the token is unset. Image endpoints are path-traversal
  guarded.
- Strict Helmet CSP: no `'unsafe-eval'`, no third-party script CDN.

## Disclaimer

The legal pages reduce — but do not eliminate — the right-of-publicity / IP risk
inherent to selling user-submitted text + images on apparel. Keep a human in the
loop (that's what the draft/approval queue is for) and have counsel review before
launch. QuoteUnquote is not affiliated with Instagram or Meta Platforms, Inc.
#   Q u o t e U n q u o t e  
 #   Q u o t e U n q u o t e  
 