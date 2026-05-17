const express = require("express");
const cors = require("cors");
require("dotenv").config();
const db = require("./config/db");

// Routes
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

// Jobs
const { startCleanupJob } = require("./cleanup");

const app = express();

// ✅ Allowed origins
const allowedOrigins = [
  "http://localhost:3000",
  "https://tapam.mipitech.com.ng",
  "https://polexvtu-admin.vercel.app",
];

// ✅ CORS setup (handles preflight automatically)
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ✅ Parse JSON bodies
app.use(express.json());

// ✅ Confirm DB connection + start cleanup job
db`SELECT 1`
  .then(() => {
    console.log("✅ PostgreSQL Connected to Supabase");
    startCleanupJob();
  })
  .catch((err) => console.error("❌ Database Connection Failed:", err));

// ✅ API routes
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

// ✅ Root + Health check
app.get("/", (req, res) => res.send("🚀 Polex VTU API is running successfully!"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// ✅ Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`⚡ Server running on port ${PORT}`));