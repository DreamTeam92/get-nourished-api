import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { WebhooksHelper } from "square";

dotenv.config();

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
        `${req.protocol}://${req.get("host")}${req.originalUrl}`;

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

      const event = JSON.parse(requestBody);

      console.log("Square webhook received:", {
        eventId: event.event_id,
        type: event.type,
      });

      return res.sendStatus(200);
    } catch (error) {
      console.error("Square webhook processing error:", error);
      return res.status(500).send("Webhook processing error");
    }
  }
);

app.use(express.json());

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Get Nourished API running on port ${PORT}`);
});
