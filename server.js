"use strict";

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./config/db");

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const walletRoutes = require("./routes/wallet");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");
const transactionRoutes = require("./routes/transaction");
const vtuRoutes = require("./routes/vtu");
const buyDataRoutes = require("./routes/buydata");
const cableTvRoutes = require("./routes/cabletv");
const buyCableTvRoutes = require("./routes/buycabletv");
const electricityRoutes = require("./routes/electricity");
const educationRoutes = require("./routes/education");
const forgetpassRoutes = require("./routes/forgetpass");
const pingRoutes = require("./routes/ping");
const smsRoutes = require("./routes/sms");
const airtimeRoutes = require("./routes/airtime");
const bettingRoutes = require("./routes/betting");
const giftcardsRoutes = require("./routes/giftcards");
const webhookRoutes = require("./routes/webhook");
const virtualAccountRoutes = require("./routes/virtualAccount");
const notificationRoutes = require("./routes/notifications");
const walletAdminRoutes = require("./routes/wallet-admin");
const airtimeWebhookRoutes = require("./routes/airtimeWebhook");

// ─────────────────────────────────────────────
// JOBS
// ─────────────────────────────────────────────

const { startCleanupJob } = require("./cleanup");
const startVerifyJob = require("./jobs/verify-pending");

const app = express();

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────

const allowedOrigins = [
  "http://localhost:3000",
  "https://tapam.mipitech.com.ng",
  "https://polexvtu-admin.vercel.app",
];

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests without an Origin header
      // such as server-to-server/webhook requests.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("Not allowed by CORS")
      );
    },

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "PaymentPoint-Signature",
      "paymentpoint-signature",
    ],

    credentials: true,
  })
);

// ─────────────────────────────────────────────
// JSON BODY PARSER
//
// IMPORTANT:
// Keep rawBody because PaymentPoint webhook
// signature verification requires the original
// request body.
// ─────────────────────────────────────────────

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

app.use("/api/auth", authRoutes);

// ─────────────────────────────────────────────
// USER
// ─────────────────────────────────────────────

app.use("/api/user", userRoutes);

// ─────────────────────────────────────────────
// WALLET
// ─────────────────────────────────────────────

app.use("/api/wallet", walletRoutes);

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────

app.use("/api/admin", adminRoutes);

// ─────────────────────────────────────────────
// WITHDRAW
// ─────────────────────────────────────────────

app.use("/api/withdraw", withdrawRoutes);

// ─────────────────────────────────────────────
// TRANSACTIONS
// ─────────────────────────────────────────────

app.use("/api/transactions", transactionRoutes);

// ─────────────────────────────────────────────
// VTU
// ─────────────────────────────────────────────

app.use("/api/vtu", vtuRoutes);
app.use("/api/buydata", buyDataRoutes);
app.use("/api/cabletv", cableTvRoutes);
app.use("/api/buycabletv", buyCableTvRoutes);
app.use("/api/electricity", electricityRoutes);
app.use("/api/education", educationRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/airtime", airtimeRoutes);
app.use("/api/betting", bettingRoutes);
app.use("/api/giftcards", giftcardsRoutes);
app.use("/api/admin", walletAdminRoutes);
app.use("/api/webhooks", airtimeWebhookRoutes);

// ─────────────────────────────────────────────
// FORGOT PASSWORD
// ─────────────────────────────────────────────

app.use(
  "/api/forgot-password",
  forgetpassRoutes
);

// ─────────────────────────────────────────────
// PING
// ─────────────────────────────────────────────

app.use("/api/ping", pingRoutes);

// ─────────────────────────────────────────────
// VIRTUAL ACCOUNTS
// ─────────────────────────────────────────────

app.use(
  "/api/virtual-account",
  virtualAccountRoutes
);

// ─────────────────────────────────────────────
// NOTIFICATIONS
//
// GET    /api/notifications
// POST   /api/notifications
// DELETE /api/notifications/:id
// PATCH  /api/notifications/:id/deactivate
// ─────────────────────────────────────────────

app.use(
  "/api/notifications",
  notificationRoutes
);

// ─────────────────────────────────────────────
// WEBHOOKS
//
// PaymentPoint:
// POST /api/webhook/paymentpoint
//
// EasyAccess:
// POST /api/webhook/easyaccess
// ─────────────────────────────────────────────

app.use(
  "/api/webhook",
  webhookRoutes
);

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send(
    "🚀 Polex VTU API is running successfully!"
  );
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

// ─────────────────────────────────────────────
// DATABASE + JOBS
// ─────────────────────────────────────────────

db`SELECT 1`
  .then(() => {
    console.log(
      "✅ PostgreSQL Connected to Supabase"
    );

    startCleanupJob();

    startVerifyJob(db);
  })
  .catch((err) => {
    console.error(
      "❌ Database Connection Failed:",
      err
    );
  });

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(
    `⚡ Server running on port ${PORT}`
  );
});

