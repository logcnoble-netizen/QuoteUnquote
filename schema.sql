-- =============================================================================
-- QuoteUnquote — Optional PostgreSQL schema
-- -----------------------------------------------------------------------------
-- The app ships with a zero-config JSON data store (src/db.js) so it runs
-- immediately. For durable, concurrent production data on Railway, provision a
-- Postgres plugin and port src/db.js to these tables. The JSON store and this
-- schema model the SAME shapes (orders, inventory, reviews, idempotency).
-- =============================================================================

CREATE TABLE IF NOT EXISTS reviews (
    id           TEXT PRIMARY KEY,
    handle       TEXT NOT NULL,
    verified     BOOLEAN NOT NULL DEFAULT FALSE,
    rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body         TEXT NOT NULL,
    has_photo    BOOLEAN NOT NULL DEFAULT FALSE,
    photo_shade  TEXT,                    -- placeholder swatch key for the UI
    size         TEXT,
    approved     BOOLEAN NOT NULL DEFAULT FALSE,   -- only approved reviews are served
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews (rating) WHERE approved;

-- Local stock pools for BULK (pre-printed, warehoused) SKUs.
CREATE TABLE IF NOT EXISTS inventory (
    product_id   TEXT NOT NULL,
    size         TEXT NOT NULL,
    quantity     INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (product_id, size)
);

CREATE TABLE IF NOT EXISTS orders (
    id                TEXT PRIMARY KEY,          -- internal id (ord_...)
    token             TEXT UNIQUE NOT NULL,      -- public, non-sequential tracking token
    payment_intent_id TEXT UNIQUE,               -- Stripe PI, set at checkout
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|fulfilled|fulfillment_failed|needs_review
    amount            INTEGER NOT NULL,          -- charged total, minor units (cents)
    currency          TEXT NOT NULL DEFAULT 'usd',
    email             TEXT,
    items             JSONB NOT NULL,            -- line items incl. custom text metadata
    shipping          JSONB,                     -- address_to captured from Stripe
    printify_order_id TEXT,
    tracking          JSONB,                     -- {carrier, number, url, status}
    capi_sent         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

-- Idempotency ledger: guarantees a Stripe event / payment intent is only ever
-- fulfilled once, even if Stripe retries the webhook.
CREATE TABLE IF NOT EXISTS processed_events (
    event_id     TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
