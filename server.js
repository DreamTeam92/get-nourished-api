import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SquareClient, SquareEnvironment, WebhooksHelper } from "square";
import pg from "pg";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";
import { Resend } from "resend";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const RESEND_FROM_EMAIL = "hello@getnourished.me";

const EBOOK_OBJECT_KEY =
  "ebooks/5-ingredients-recipe-ebook.pdf";

async function sendEbookDeliveryEmail(recipientEmail, downloadUrl) {
  const result = await resend.emails.send({
    from: RESEND_FROM_EMAIL,
    to: recipientEmail,
    subject: "Your Get Nourished eBook is ready 🌿",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; padding: 40px 24px; color: #2f332d;">
        <h1 style="font-family: Georgia, serif; font-size: 32px; font-weight: normal;">
          Your eBook is ready.
        </h1>

        <p style="font-size: 16px; line-height: 1.7;">
          Thank you for your purchase of the Get Nourished eBook.
        </p>

        <p style="font-size: 16px; line-height: 1.7;">
          Your secure download link is ready below.
        </p>

        <p style="margin: 32px 0;">
          <a
            href="${downloadUrl}"
            style="display: inline-block; padding: 14px 24px; background: #2f332d; color: #ffffff; text-decoration: none; font-size: 14px;"
          >
            DOWNLOAD YOUR EBOOK
          </a>
        </p>

        <p style="font-size: 13px; line-height: 1.6; color: #666666;">
          This secure download link is valid for 72 hours.
        </p>

        <p style="font-size: 13px; line-height: 1.6; color: #666666;">
          With love,<br />
          Get Nourished
        </p>
      </div>
    `,
  });

  if (result.error) {
    throw new Error(
      `Resend email failed: ${result.error.message}`,
    );
  }

  return result;
}

const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const squareEnvironment =
  process.env.SQUARE_ENVIRONMENT?.toLowerCase() === "sandbox"
    ? SquareEnvironment.Sandbox
    : SquareEnvironment.Production;

const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: squareEnvironment,
});

const PUBLIC_API_BASE_URL =
  squareEnvironment === SquareEnvironment.Sandbox
    ? "https://get-nourished-api-sandbox.onrender.com"
    : "https://get-nourished-api.onrender.com";

function generateDeliveryToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashDeliveryToken(token) {
  return crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

async function createSignedDownloadUrl(objectKey) {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
  });

  return getSignedUrl(r2Client, command, {
    expiresIn: 900,
  });
}

async function createSecureDownloadUrl(token) {
  const result = await getValidDeliveryToken(token);

  if (!result.valid) {
    return {
      success: false,
      reason: result.reason,
      delivery: result.delivery ?? null,
    };
  }

  let signedUrl;

  try {
    signedUrl = await createSignedDownloadUrl(
      result.delivery.object_key,
    );
  } catch (error) {
    console.error("Secure download signing failed:", error);

    return {
      success: false,
      reason: "signing_failed",
      delivery: result.delivery ?? null,
    };
  }

  const redeemed = await redeemDeliveryToken(result.delivery.id);

  if (!redeemed) {
    return {
      success: false,
      reason: "redeemed",
    };
  }

  return {
    success: true,
    signedUrl,
    deliveryTokenId: result.delivery.id,
    paymentId: result.delivery.payment_id,
    expiresAt: result.delivery.expires_at,
  };
}

const DELIVERY_TOKEN_TTL_HOURS = 72;

async function createDeliveryToken(paymentId, objectKey) {
  const token = generateDeliveryToken();
  const tokenHash = hashDeliveryToken(token);

  const deliveryTokenId = crypto.randomUUID();

  const expiresAt = new Date(
    Date.now() + DELIVERY_TOKEN_TTL_HOURS * 60 * 60 * 1000,
  );

  await pool.query(
    `
      INSERT INTO delivery_tokens (
        id,
        payment_id,
        object_key,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      deliveryTokenId,
      paymentId,
      objectKey,
      tokenHash,
      expiresAt,
    ],
  );

  return {
    id: deliveryTokenId,
    token,
    expiresAt,
  };
}


async function getValidDeliveryToken(token) {
  const tokenHash = hashDeliveryToken(token);

  const existing = await pool.query(
    `
      SELECT
        id,
        payment_id,
        object_key,
        expires_at,
        redeemed_at
      FROM delivery_tokens
      WHERE token_hash = $1
      LIMIT 1
    `,
    [tokenHash],
  );

  if (existing.rows.length === 0) {
    return {
      valid: false,
      reason: "invalid",
    };
  }

  const delivery = existing.rows[0];

  if (new Date(delivery.expires_at) <= new Date()) {
    return {
      valid: false,
      reason: "expired",
      delivery,
    };
  }

  if (delivery.redeemed_at) {
    return {
      valid: false,
      reason: "redeemed",
      delivery,
    };
  }

  return {
    valid: true,
    delivery,
  };
}

async function redeemDeliveryToken(deliveryTokenId) {
  const result = await pool.query(
    `
      UPDATE delivery_tokens
      SET redeemed_at = NOW()
      WHERE id = $1
        AND expires_at > NOW()
        AND redeemed_at IS NULL
      RETURNING id
    `,
    [deliveryTokenId],
  );

  return result.rows.length > 0;
}

async function logDeliveryAudit({
  deliveryTokenId = null,
  paymentId = null,
  eventType,
  success,
  ipAddress = null,
  userAgent = null,
  details = null,
}) {
  try {
    const auditResult = await pool.query(
      `
        INSERT INTO delivery_audit_log (
          delivery_token_id,
          payment_id,
          event_type,
          success,
          ip_address,
          user_agent,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        deliveryTokenId,
        paymentId,
        eventType,
        success,
        ipAddress,
        userAgent,
        details,
      ],
    );

    console.log("AUDIT INSERTED:", auditResult.rowCount);
  } catch (error) {
    console.error("Download audit logging failed:", error);
  }
}

const app = express();





app.get("/api/download", async (req, res) => {
  try {
    const token = req.query.token;
    const ipAddress =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      null;
    const userAgent = req.get("user-agent") || null;

    if (typeof token !== "string" || token.length !== 64) {
      void logDeliveryAudit({
        eventType: "download_invalid_token",
        success: false,
        ipAddress,
        userAgent,
        details: "Invalid or malformed delivery token.",
      });

      return res.status(400).send("Invalid download link.");
    }

    const result = await createSecureDownloadUrl(token);

    if (!result.success) {
      const auditEvent =
        result.reason === "expired"
          ? "download_expired_token"
          : result.reason === "redeemed"
            ? "download_redeemed_token"
            : result.reason === "signing_failed"
              ? "download_signing_failed"
              : "download_invalid_token";

      void logDeliveryAudit({
        deliveryTokenId: result.delivery?.id ?? null,
        paymentId: result.delivery?.payment_id ?? null,
        eventType: auditEvent,
        success: false,
        ipAddress,
        userAgent,
        details: `Download rejected: ${result.reason}.`,
      });

      if (result.reason === "expired") {
        return res.status(410).send("This download link has expired.");
      }

      if (result.reason === "redeemed") {
        return res.status(410).send("This download link has already been used.");
      }

      if (result.reason === "signing_failed") {
        return res.status(503).send("Download temporarily unavailable. Please try again.");
      }

      return res.status(404).send("Invalid download link.");
    }

    void logDeliveryAudit({
      deliveryTokenId: result.deliveryTokenId,
      paymentId: result.paymentId,
      eventType: "download_success",
      success: true,
      ipAddress,
      userAgent,
      details: "Secure download URL issued.",
    });

    return res.redirect(302, result.signedUrl);
  } catch (error) {
    console.error("Download request failed:", error);

    void logDeliveryAudit({
      eventType: "download_error",
      success: false,
      ipAddress:
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        null,
      userAgent: req.get("user-agent") || null,
      details: "Unexpected download request failure.",
    });

    return res.status(500).send("Download temporarily unavailable.");
  }
});


const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Get Nourished API is alive! ❤️",
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "get-nourished-api",
  });
});

app.post(
  "/api/webhooks/square",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      // --------------------------------------------------
      // 1. Verify Square webhook signature
      // --------------------------------------------------

      const signature = req.headers["x-square-hmacsha256-signature"];

      if (!signature) {
        console.warn("Square webhook rejected: missing signature");
        return res.status(403).send("Missing Square signature");
      }

      const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

      if (!signatureKey) {
        console.error("Square webhook signature key is not configured");
        return res.status(500).send("Webhook configuration error");
      }

      const notificationUrl =
        process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ||
        "https://get-nourished-api.onrender.com/api/webhooks/square";

      const requestBody = req.body.toString("utf8");

      const isValid = await WebhooksHelper.verifySignature({
        requestBody,
        signatureHeader: signature,
        signatureKey,
        notificationUrl,
      });

      if (!isValid) {
        console.warn("Square webhook rejected: invalid signature");
        return res.status(403).send("Invalid Square signature");
      }

      // --------------------------------------------------
      // 2. Parse Square event
      // --------------------------------------------------

      const event = JSON.parse(requestBody);

      console.log("Square webhook received:", {
        eventId: event.event_id,
        type: event.type,
      });

      // --------------------------------------------------
      // 3. Basic event ID check
      // --------------------------------------------------

      const eventId = event.event_id;

      if (!eventId) {
        console.warn("Square webhook has no event ID");
        return res.status(400).send("Missing event ID");
      }

      const insertEvent = await pool.query(
        `INSERT INTO processed_webhook_events (event_id)
        VALUES ($1)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id`,
        [eventId],
      );

      if (insertEvent.rows.length === 0) {
        console.log("Duplicate Square event ignored:", eventId);
        return res.sendStatus(200);
      }

      console.log("Square event accepted for processing:", eventId);

      // --------------------------------------------------
      // 4. Only process payment events
      // --------------------------------------------------

      if (
        event.type !== "payment.created" &&
        event.type !== "payment.updated"
      ) {
        console.log("Ignoring non-payment event:", event.type);
        return res.sendStatus(200);
      }

      // --------------------------------------------------
      // 5. Extract payment ID
      // --------------------------------------------------

      const paymentId = event.data?.object?.payment?.id;

      if (!paymentId) {
        console.warn("Square webhook has no payment ID");
        return res.status(400).send("Missing payment ID");
      }

      console.log("Retrieving payment from Square:", paymentId);

      // --------------------------------------------------
      // 6. Retrieve the payment directly from Square
      // --------------------------------------------------

      let paymentResponse;

      try {
        paymentResponse = await squareClient.payments.get({
          paymentId,
        });
      } catch (error) {
        if (error?.statusCode === 404) {
          console.warn(
            "Square payment does not exist. Ignoring event:",
            paymentId,
          );

          return res.sendStatus(200);
        }

        throw error;
      }

      console.log("Square payments.get() response received:", {
        hasPayment: Boolean(paymentResponse?.payment),
        responseKeys: paymentResponse ? Object.keys(paymentResponse) : [],
      });

      const payment = paymentResponse?.payment;

      if (!payment) {
        console.warn(
          "Square payment response contained no payment:",
          paymentId,
        );
        return res.sendStatus(200);
      }

      // --------------------------------------------------
      // 7. Verify the actual Square payment
      // --------------------------------------------------

      console.log("Square payment verified:", {
        paymentId: payment.id,
        status: payment.status,
        locationId: payment.locationId,
        orderId: payment.orderId,
      });

      // --------------------------------------------------
      // 8. Only completed payments can continue
      // --------------------------------------------------

      if (payment.status !== "COMPLETED") {
        console.log(
          `Payment ${payment.id} is not completed. Current status: ${payment.status}`,
        );

        return res.sendStatus(200);
      }
      // --------------------------------------------------
      // 9. Payment-level fulfillment lock
      // --------------------------------------------------

      const fulfillmentInsert = await pool.query(
        `INSERT INTO fulfillment_records (
     payment_id,
     order_id,
     customer_id,
     status
   )
   VALUES ($1, $2, $3, 'pending')
   ON CONFLICT (payment_id) DO NOTHING
   RETURNING payment_id`,
        [payment.id, payment.orderId ?? null, payment.customerId ?? null],
      );

      if (fulfillmentInsert.rows.length === 0) {
        console.log(
          `Duplicate payment ignored — fulfillment already exists: ${payment.id}`,
        );
        return res.sendStatus(200);
      }

      console.log(`🟢 Fulfillment claimed for payment: ${payment.id}`);

      // --------------------------------------------------
      // 9b. Mark fulfillment as processing
      // --------------------------------------------------

      await pool.query(
        `UPDATE fulfillment_records
   SET
     status = 'processing',
     updated_at = NOW()
   WHERE payment_id = $1
     AND status = 'pending'`,
        [payment.id],
      );

      console.log(`🔵 Fulfillment processing started: ${payment.id}`);

      // --------------------------------------------------
      // 9c. Resolve customer / recipient email
      // --------------------------------------------------

      let recipientEmail = null;

      // Path 1: Payment -> Customer -> emailAddress
      if (payment.customerId) {
        try {
          console.log(
            "Retrieving customer from Square:",
            payment.customerId,
          );

          const customerResponse = await squareClient.customers.get({
            customerId: payment.customerId,
          });

          const customer = customerResponse?.customer;

          console.log("Square customer response received:", {
            hasCustomer: Boolean(customer),
            hasEmail: Boolean(customer?.emailAddress),
          });

          if (customer?.emailAddress) {
            recipientEmail = customer.emailAddress;
      console.log(
              "✅ Recipient email resolved from Square Customer:",
              recipientEmail,
            );
          }
        } catch (error) {
          console.warn(
            `⚠️ Customer lookup failed for payment ${payment.id}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        console.log(
          "No customer ID on payment — checking Order fulfillment recipient.",
        );
      }

      // Path 2: Payment -> Order -> Digital fulfillment -> recipient.emailAddress
      if (!recipientEmail && payment.orderId) {
        try {
          console.log(
            "Retrieving order from Square:",
            payment.orderId,
          );

          const orderResponse = await squareClient.orders.get({
            orderId: payment.orderId,
          });

          const fulfillments = orderResponse?.order?.fulfillments ?? [];

          for (const fulfillment of fulfillments) {
            const email = fulfillment?.recipient?.emailAddress;

            if (email) {
              recipientEmail = email;
              break;
            }
          }

          if (recipientEmail) {
      console.log(
              "✅ Recipient email resolved from Order fulfillment:",
              recipientEmail,
            );
          } else {
      console.log(
              "No recipient email found on Order fulfillment.",
            );
          }
        } catch (error) {
          console.warn(
            `⚠️ Order lookup failed for payment ${payment.id}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // --------------------------------------------------
      // 9d. Save recipient email / safely stop if unavailable
      // --------------------------------------------------

      if (!recipientEmail) {
        const errorMessage =
          "No recipient email could be resolved from Square payment/customer/order.";

        await pool.query(
          `UPDATE fulfillment_records
           SET
             status = 'failed',
             last_error = $1,
             updated_at = NOW()
           WHERE payment_id = $2
             AND status = 'processing'`,
          [errorMessage, payment.id],
        );

        console.warn(
          `🟠 Fulfillment stopped safely for payment ${payment.id}: ${errorMessage}`,
        );

        return res.sendStatus(200);
      }

      await pool.query(
        `UPDATE fulfillment_records
         SET
           recipient_email = $1,
           updated_at = NOW()
         WHERE payment_id = $2
           AND status = 'processing'`,
        [recipientEmail, payment.id],
      );

      console.log(
        `💾 Recipient email saved for payment ${payment.id}`,
      );

      // --------------------------------------------------
      // 10. Create secure delivery token
      // --------------------------------------------------

      const delivery = await createDeliveryToken(
        payment.id,
        EBOOK_OBJECT_KEY,
      );

      const downloadUrl =
        `${PUBLIC_API_BASE_URL}/api/download?token=${encodeURIComponent(delivery.token)}`;

      console.log(
        `🎟️ Delivery token created for payment ${payment.id}`,
      );

      // --------------------------------------------------
      // 11. Send secure eBook email
      // --------------------------------------------------

      try {
        await sendEbookDeliveryEmail(
          recipientEmail,
          downloadUrl,
        );

        await pool.query(
          `UPDATE fulfillment_records
           SET
             status = 'sent',
             sent_at = NOW(),
             updated_at = NOW(),
             last_error = NULL
           WHERE payment_id = $1
             AND status = 'processing'`,
          [payment.id],
        );

        console.log(
          `📧 eBook delivery email sent successfully: ${payment.id}`,
        );

        // --------------------------------------------------
        // 12. Fulfillment complete
        // --------------------------------------------------

        console.log(
          `✅ PAYMENT FULFILLED — eBook delivery complete: ${payment.id}`,
        );

        return res.sendStatus(200);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        await pool.query(
          `UPDATE fulfillment_records
           SET
             status = 'failed',
             last_error = $1,
             updated_at = NOW()
           WHERE payment_id = $2
             AND status = 'processing'`,
          [errorMessage, payment.id],
        );

        console.error(
          `🔴 eBook delivery email failed for payment ${payment.id}:`,
          errorMessage,
        );

        return res.sendStatus(200);
      }
    } catch (error) {
      console.error(
        "Square webhook processing error:",
        error,
      );

      return res.status(500).send(
        "Webhook processing error",
      );
    }
  },
);

// JSON parser for all other routes
app.use(express.json());

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Get Nourished API running on port ${PORT}`);
});
