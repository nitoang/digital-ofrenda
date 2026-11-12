-- Purchase history, partial refunds and disputes (server/billing.mjs, server/purchases.mjs).
-- user_id says who bought, so a person can see their own purchases. It is cleared (not the row deleted) when the account
-- is deleted, so the record of the sale stays without a link to anyone.
ALTER TABLE purchases ADD COLUMN user_id TEXT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE purchases ADD COLUMN amount INTEGER;                       -- what was charged, in the currency's smallest unit (cents)
ALTER TABLE purchases ADD COLUMN currency TEXT;                        -- three lower-case letters, as Stripe gives it
ALTER TABLE purchases ADD COLUMN amount_refunded INTEGER NOT NULL DEFAULT 0;  -- a partial refund; a full one also sets refunded_at
ALTER TABLE purchases ADD COLUMN dispute_status TEXT;                  -- Stripe's dispute status; 'lost' takes the upgrade back
ALTER TABLE purchases ADD COLUMN disputed_at INTEGER;
CREATE INDEX purchases_user ON purchases (user_id, paid_at);
