# Get Nourished API — Project State

> **Built by Viki & ChatGPT with ❤️**
>
> Durable project handoff/state document so development can continue safely if the chat becomes too large or we move to a new conversation.
>
> **Last updated:** 2026-09-20

## 1. Project

**Project:** Get Nourished eBook Delivery
**Repository:** `get-nourished-api`
**GitHub:** `DreamTeam92/get-nourished-api` (private)
**Local path:** `/home/nyulik/get-nourished-api`

### Core goal

Build a secure automated digital-product delivery system:

```text
Square payment
    ↓
Square webhook
    ↓
Server-side payment verification
    ↓
Fulfillment record
    ↓
Secure delivery token
    ↓
Private Cloudflare R2 object
    ↓
Short-lived signed download URL
    ↓
Resend customer email
    ↓
eBook delivery
```

The architecture is intended to become reusable for future paid digital products.

## 2. Technology Stack

- Node.js
- Express 5
- Square SDK / Square Payments + Checkout
- Resend
- PostgreSQL
- Cloudflare R2 (S3-compatible API)
- AWS SDK for JavaScript
- Render for API hosting
- GitHub for source control

Important installed packages include:

- `square`
- `express`
- `dotenv`
- `cors`
- `resend`
- `pg`
- `@aws-sdk/client-s3`
- `@aws-sdk/lib-storage`
- `@aws-sdk/s3-request-presigner`

The project uses ES modules and `server.js` as the main server entry point.

## 3. Square

### Production

- Production Square location ID: `L2RJPVX2ACQXK`
- Production API/webhook flow is deployed and working.
- Square-hosted Checkout was selected as the intended customer payment architecture.

### Sandbox

- Sandbox location ID: `LAG2PW9Q2MRKH`
- Sandbox Render API: `https://get-nourished-api-sandbox.onrender.com`

### Architecture decision

Use:

**Square-hosted Checkout + secure Get Nourished backend + Resend**

Reason:
- Square hosts the payment page.
- Our backend does not handle card numbers/CVV.
- Webhooks are signed.
- Backend verifies the payment server-side.
- Customer identity/email is resolved from Square data when available.
- Delivery is handled separately through controlled tokens and private storage.

### Important Sandbox finding

Square's Sandbox Developer Control Panel test-payment simulator did not reliably expose buyer identity (`customer_id` / fulfillment recipient email) through the retrieved Payment/Order objects.

Do **not** build production logic around that simulator quirk.

Production resolver strategy:
1. If completed Payment has `customerId`, retrieve the Customer and use `emailAddress`.
2. Otherwise inspect the Order's digital fulfillment recipient email when available.
3. If no usable recipient email exists, do not send the eBook; preserve the fulfillment for safe recovery/retry.

## 4. Deployment

### Production Render service

- Service: `get-nourished-api`
- URL: `https://get-nourished-api.onrender.com`
- Branch: `main`

### Sandbox Render service

- Service: `get-nourished-api-sandbox`
- URL: `https://get-nourished-api-sandbox.onrender.com`
- Branch: `main`
- Node service
- Build: `npm install`
- Start: `npm start`

Production has intentionally not been changed during the recent R2/token security work.

## 5. Database

### Current Sandbox database

Render PostgreSQL:
- `get-nourished-db-sandbox`
- PostgreSQL 18.6
- Oregon
- Free plan
- 1 GB
- Current free database expiry: **2026-10-13** unless changed/upgraded/migrated.

The database is standard PostgreSQL and should remain portable.

### Existing tables

`processed_webhook_events`

```sql
CREATE TABLE processed_webhook_events (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`fulfillment_records`

```sql
CREATE TABLE fulfillment_records (
  payment_id TEXT PRIMARY KEY,
  order_id TEXT,
  customer_id TEXT,
  recipient_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_error TEXT
);
```

### Delivery tables

```sql
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
```

### Database migration plan

Do not rush the database migration.

Finish the system first. Before the Render Free PostgreSQL expiry, migrate/export the small database to a suitable permanent PostgreSQL provider or plan.

The application uses `DATABASE_URL`, so the database location can be changed without redesigning the application.

## 6. Cloudflare R2

### Bucket

`get-nourished-ebooks`

The bucket is intended to remain private.

Current object:

```text
ebooks/5-ingredients-recipe-ebook.pdf
```

Only the first eBook has been uploaded so far.

### R2 integration

The backend uses:

- `S3Client`
- `GetObjectCommand`
- `getSignedUrl`

The signing helper currently uses:

```js
expiresIn: 900
```

Therefore the intended customer signed download URL lifetime is **15 minutes**.

### Proven tests

#### Signed URL generation

Passed:
- signed URL generated successfully
- correct object key
- configured lifetime: 900 seconds

#### Signed URL access

Passed:
- fresh signed URL returned HTTP `200`

#### Signed URL expiry

Passed:
- temporary 1-second signed URL returned HTTP `200` immediately
- same URL after waiting 3 seconds returned HTTP `403`

This proves the signed URL expiry behaviour.

#### Important unsigned-access test note

An initial SDK test returned HTTP 200 because it used the backend's authenticated R2 credentials. That was correctly identified as a backend-access test, not a public-access test.

A later unauthenticated HTTP test returned HTTP `400`, meaning the attempted unsigned endpoint request was rejected. This should **not** be overclaimed as universal proof of every possible public-access path.

The intended bucket configuration remains private, and public-access verification should be revisited with a proper Cloudflare/R2 configuration-level check if needed.

## 7. Delivery Token Security

### Current token design

Delivery token:
- generated with `crypto.randomBytes(32).toString("hex")`
- only SHA-256 hash stored in DB
- raw token is never stored in the database
- TTL: 72 hours
- one-time redemption
- first successful redemption wins
- expired/redeemed tokens are rejected

Current constants/helpers include:

```js
function generateDeliveryToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashDeliveryToken(token) {
  return crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

const DELIVERY_TOKEN_TTL_HOURS = 72;
```

### Proven tests

#### Fresh token

Passed:
- token created
- token verified successfully
- first redemption returned `valid: true`

#### Reuse protection

Passed:
- second attempt returned:
  - `valid: false`
  - `reason: "redeemed"`

#### Audit logging

Passed:
- `logDeliveryAudit()` is called
- database INSERT succeeded
- successful first redemption was tested
- reused-token attempt was tested

Example verified reused-token audit record:

```text
payment_id:  hsK0ju907aTV7GX1uZz2ybSFBk9YY
event_type:  delivery_token_verification
success:     false
details:     redeemed
```

The successful first-redemption audit path also produced:

```text
AUDIT INSERTED: 1
```

## 8. Current Delivery Helpers

### `createDeliveryToken(paymentId, objectKey)`

Creates:
- random raw token
- SHA-256 hash
- UUID delivery token ID
- 72-hour expiry
- DB row

Returns the raw token to the caller so it can be delivered to the customer.

### `verifyDeliveryToken(token)`

Current behaviour:
- atomically marks a valid token as redeemed
- returns valid/invalid result
- distinguishes invalid, expired, redeemed, unavailable states

### Important production-hardening issue

Current `verifyDeliveryToken()` redeems the token before the later R2 signed URL operation.

Therefore, if R2 signing failed after verification, a customer's one-time token could be consumed without receiving a usable download URL.

**This must be redesigned before production.**

Preferred production behaviour:
- token authorization/redeeming and signed URL generation should be coordinated so a failed signing step does not unnecessarily burn the customer's only delivery authorization.
- recovery/retry behaviour must be explicitly designed.

## 9. Audit Logging

Current helper inserts into `delivery_audit_log` and development testing confirms the insert succeeds.

The development helper currently logs:

```text
AUDIT INSERTED: 1
```

The console logging should be reviewed during production hardening.

## 10. Current Test Endpoints

Temporary endpoints have been used during development, including:

- `/api/test/delivery-token`
- `/api/test/verify-delivery-token`
- `/api/test/r2`
- `/api/test/signed-url`
- `/api/test/signed-url-short`
- `/api/test/r2-unsigned`
- `/api/test/secure-download`

These are **development/test endpoints**.

### Production requirement

Before production:
- remove them or lock them down
- do not leave token-generation or storage diagnostics publicly callable
- remove test-only environment dependencies
- ensure no endpoint exposes secrets, raw tokens, signed URLs, or internal diagnostics

## 11. Current Secure Download Bridge

A helper has been added:

```js
async function createSecureDownloadUrl(token) {
  const result = await verifyDeliveryToken(token);

  if (!result.valid) {
    return {
      success: false,
      reason: result.reason,
    };
  }

  const signedUrl = await createSignedDownloadUrl(
    result.delivery.object_key,
  );

  return {
    success: true,
    signedUrl,
    paymentId: result.delivery.payment_id,
    expiresAt: result.delivery.expires_at,
  };
}
```

A temporary `/api/test/secure-download` endpoint calls it.

### Current status

The first test using it returned:

```text
reason: redeemed
```

because the test environment variable still contained an already-redeemed token.

A fresh delivery token has since been generated and is available for the next local test.

### Important

Do not expose the raw token or signed URL in chat.

## 12. Resend

Resend has been connected and successfully tested previously.

Final customer email flow is not yet fully wired to the secure download link.

Target:

```text
Square payment
→ webhook
→ fulfillment
→ recipient email
→ Resend
→ secure delivery link
→ token verification
→ signed R2 URL
→ eBook
```

## 13. Webhook / Fulfillment

Completed work includes:
- Square webhook signature verification
- genuine Sandbox `payment.created` testing
- payment retrieval/verification
- missing-payment handling
- event idempotency table
- fulfillment records
- state transitions

Fulfillment states:

```text
pending
processing
sent
failed
```

Tested transitions include:
- pending → processing
- processing → sent with `sent_at`
- processing → failed with `last_error`

### Production-hardening items still needed

1. Event-level idempotency recovery if processing fails after event insertion.
2. Payment-level recovery/retry handling.
3. Avoid unnecessarily long webhook processing before acknowledging Square.
4. Robust email recipient resolution.
5. Safe retry behaviour.
6. Final email + delivery integration.

## 14. Git / Local Working State

Private GitHub repository:

`https://github.com/DreamTeam92/get-nourished-api`

Known commits before recent token/R2 work include:

- `4a7a5ab Harden R2 diagnostic endpoint`
- `7ac1a2c Add R2 diagnostic error details`
- `f5432f2 Add Cloudflare R2 integration`
- `306c2d8 Add Square recipient email resolution`
- `b9e8902 Add payment fulfillment state tracking`

Known local uncommitted items from the current development period include:

- `package.json`
- `package-lock.json`
- `migrations/`
- `server.b5-webhook-backup.js`
- `upload-ebook.js`
- current `server.js` security/R2 changes

**Do not delete `server.b5-webhook-backup.js`.**

`upload-ebook.js` is local tooling and has not been intended for production deployment.

`migrations/001_create_delivery_tables.sql` is the local database migration.

Before a production milestone, review `git status`, inspect the diff, then commit/push deliberately.

## 15. Environment / Secrets

Secrets must never be committed or pasted into ChatGPT.

`.env` contains sensitive configuration.

`.gitignore` excludes `.env` and `.env.*` except `.env.example`.

Eventually `.env.example` should document required variables without values, including:
- Square configuration
- Resend configuration
- `DATABASE_URL`
- R2 configuration
- relevant delivery settings

Never include real tokens, passwords, database URLs, API keys, or raw delivery tokens in this document.

## 16. Development Rules

The preferred development style for this project:

- one small change at a time
- syntax-check before starting the server
- start local API only after syntax is clean
- test one behaviour at a time
- never expose secrets
- preserve working checkpoints
- do not blindly overwrite working code
- use exact insertion points when editing `server.js`
- test security failures deliberately, not only happy paths

## 17. Current Milestones

### B1 — Square setup
**COMPLETE**

### B2 — Backend local
**COMPLETE**

### B2 security
**COMPLETE**

### GitHub private repository
**COMPLETE**

### B3 — Render deployment
**COMPLETE**

### B4 — Webhook
**COMPLETE**

### B4 invalid signature test
**COMPLETE**

### B4 production webhook deployment
**COMPLETE**

### B4 genuine Square webhook test
**COMPLETE**

### B5.1 — payment verification
**COMPLETE**

### B5.1.1 — missing payment handling
**COMPLETE**

### B5.1.2 — Sandbox webhook signature test
**COMPLETE**

### B5.2 — customer lookup / recipient investigation
**COMPLETE / simulator limitation documented**

### B5.3 — fulfillment database/state tracking
**COMPLETE**

### R2 private storage
**COMPLETE**

### Delivery token system
**COMPLETE / production hardening still required**

### Delivery audit log
**COMPLETE / production hardening still required**

### R2 signed URLs
**COMPLETE / expiry proven**

### Token → signed URL bridge
**IN PROGRESS**

### Resend → secure delivery email
**NOT YET COMPLETE**

### Full end-to-end payment → email → eBook test
**NOT YET COMPLETE**

### Production hardening
**NOT YET COMPLETE**

### Production database migration
**NOT YET COMPLETE**

## 18. Immediate Next Step

Continue from the current secure-download bridge test.

A fresh delivery token has just been generated for the local test.

Next:
1. Load that fresh token into the Node process environment.
2. Restart the local API with that token.
3. Call `/api/test/secure-download`.
4. Confirm the token is valid and a signed URL is generated.
5. Test the generated URL.
6. Redesign token redemption/signing so a failed R2 signing operation cannot burn a customer's only delivery authorization.
7. Build the actual customer-facing download endpoint.
8. Connect it to Resend.
9. Run the complete end-to-end Sandbox flow.
10. Perform production hardening.
11. Create/migrate the permanent PostgreSQL database before the current Render Free database expires.

## 19. Reusable Future Architecture

The finished system is intended to become a reusable secure digital-product delivery engine.

```text
Payment Provider
    ↓
Webhook Verification
    ↓
Fulfillment Engine
    ↓
Delivery Token
    ↓
Private Object Storage
    ↓
Signed URL
    ↓
Email Delivery
```

Only product-specific details should normally change:
- product
- price
- object key
- email copy/branding
- payment configuration

The reusable architecture should be extracted/refactored **after Get Nourished is fully working and hardened**, not before.

## 20. Chat Handoff Instructions

If this conversation becomes too large:

1. Start a new chat.
2. Attach/provide this `PROJECT_STATE.md`.
3. Say:

> “Captain, this is the current PROJECT_STATE.md for our Get Nourished API project. Read it and continue from the Immediate Next Step. Keep our one-small-step-at-a-time workflow and never expose secrets.”

The new conversation should use this document as the primary project-state reference, while GitHub remains the source of truth for code.







### Production database migration
COMPLETE

Production PostgreSQL is now hosted on Aiven.

Database:
get-nourished-db-production

Verified:
- processed_webhook_events
- fulfillment_records
- delivery_tokens
- delivery_audit_log

Render Production successfully connects using DATABASE_URL.
A live Square webhook event was successfully persisted to
processed_webhook_events.

CURRENT POSITION

B5.3 — COMPLETE
Production DB — COMPLETE
B5.4 — NEXT
