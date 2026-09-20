CREATE TABLE IF NOT EXISTS delivery_tokens (
  id UUID PRIMARY KEY,
  payment_id TEXT NOT NULL
    REFERENCES fulfillment_records(payment_id),
  object_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_audit_log (
  id BIGSERIAL PRIMARY KEY,
  delivery_token_id UUID
    REFERENCES delivery_tokens(id),
  payment_id TEXT,
  event_type TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_tokens_payment_id
  ON delivery_tokens(payment_id);

CREATE INDEX IF NOT EXISTS idx_delivery_tokens_expires_at
  ON delivery_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_delivery_audit_payment_id
  ON delivery_audit_log(payment_id);
