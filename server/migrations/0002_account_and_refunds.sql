-- Changing an email address, and tracing a refund back to what it paid for.
-- Apply with:  npx wrangler d1 migrations apply digital-ofrenda

-- One pending email change per person. The 6-digit code goes to the NEW address, so the change only
-- happens once they prove they control it. Stored as a hash, like every other secret here.
CREATE TABLE email_changes (
  user_id      TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  new_email    TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,               -- start of the current hour of sending, for the send limit
  sends        INTEGER NOT NULL DEFAULT 1
);

-- One row per Stripe payment we acted on. It holds no email address or name, only what was bought and for
-- what, so it is kept as a payment record even after an account is deleted. A refund marks it, and an
-- upgrade is only taken away when no other unrefunded payment still covers it (a double purchase).
CREATE TABLE purchases (
  payment_intent TEXT PRIMARY KEY,
  feature        TEXT NOT NULL,
  reference      TEXT NOT NULL,                -- the altar id, or the user id for platinum
  paid_at        INTEGER NOT NULL,
  refunded_at    INTEGER
);
CREATE INDEX purchases_reference ON purchases (reference, feature);
