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
      if (
        !origin ||
        allowedOrigins.includes(origin)
      ) {
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
    ],

    credentials: true,
  })
);

// ─────────────────────────────────────────────
// JSON
// ─────────────────────────────────────────────

app.use(express.json());

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/vtu", vtuRoutes);
app.use("/api/buydata", buyDataRoutes);
app.use("/api/cabletv", cableTvRoutes);
app.use("/api/buycabletv", buyCableTvRoutes);
app.use("/api/electricity", electricityRoutes);
app.use("/api/education", educationRoutes);
app.use("/api/forgot-password", forgetpassRoutes);
app.use("/api/ping", pingRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/airtime", airtimeRoutes);
app.use("/api/betting", bettingRoutes);
app.use("/api/giftcards", giftcardsRoutes);
app.use("/api/virtual-account", virtualAccountRoutes);

// EasyAccess webhook
app.use("/api/webhook", webhookRoutes);

// ─────────────────────────────────────────────
// HEALTH
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