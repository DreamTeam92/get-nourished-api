import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SquareClient, SquareEnvironment, WebhooksHelper } from "square";
import pg from "pg";

dotenv.config();

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

const app = express();
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

      if (payment.customerId) {
        try {
          console.log("Retrieving customer from Square:", payment.customerId);

          const customerResponse = await squareClient.customers.get({
            customerId: payment.customerId,
          });

          console.log("Square customer response received:", {
            hasCustomer: !!customerResponse.customer,
            responseKeys: Object.keys(customerResponse),
          });

          console.log(
            "Square customer:",
            JSON.stringify(customerResponse.customer, null, 2),
          );
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
            `🔴 Fulfillment failed for payment ${payment.id}:`,
            errorMessage,
          );

          return res.sendStatus(200);
        }
      } else {
        console.log("No customer ID on payment — cannot retrieve customer.");
      }

      // --------------------------------------------------
      // 10. B5.3 checkpoint
      // --------------------------------------------------

      console.log(
        `     ✅ PAYMENT COMPLETED — ready for fulfillment: ${payment.id}`,
      );

      return res.sendStatus(200);
    } catch (error) {
      console.error("Square webhook processing error:", error);
      return res.status(500).send("Webhook processing error");
    }
  },
);

// JSON parser for all other routes
app.use(express.json());

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Get Nourished API running on port ${PORT}`);
});
