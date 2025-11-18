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
const vtuRoutes = require("./routes/vtu"); // 👈 Add this line
const buyDataRoutes = require("./routes/buydata"); 
const cableTvRoutes = require("./routes/cabletv");
const buyCableTvRoutes = require("./routes/buycabletv");
const electricityRoutes = require("./routes/electricity");
const educationRoutes = require("./routes/education");
const forgetpassRoutes = require("./routes/forgetpass");
const pingRoutes = require("./routes/ping");
const smsRoutes = require("./routes/sms"); 
const airtimeRoutes = require("./routes/airtime");



const app = express();

// ✅ Allowed origins
const allowedOrigins = [
  "http://localhost:3000",       // Local dev
  "https://tapam.mipitech.com.ng", // Production frontend
];

// ✅ CORS setup (handles preflight automatically)
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (e.g., mobile apps, curl)
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

// ✅ Confirm DB connection
db`SELECT 1`
  .then(() => console.log("✅ PostgreSQL Connected to Supabase"))
  .catch((err) => console.error("❌ Database Connection Failed:", err));

// ✅ API routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/vtu", vtuRoutes); // 👈 Add this line
app.use("/api/buydata", buyDataRoutes);            // 👈 mount route
app.use("/api/cabletv", cableTvRoutes);      // fetch plans & admin prices
app.use("/api/buycabletv", buyCableTvRoutes); // buy/verify IUC
app.use("/api/electricity", electricityRoutes); // buy/verify IUC
app.use("/api/education", educationRoutes);
app.use("/api/forgot-password", forgetpassRoutes);
app.use("/api/ping", pingRoutes);
app.use("/api/sms", smsRoutes); 
app.use("/api/airtime", airtimeRoutes);  

// ✅ Root + Health check
app.get("/", (req, res) => res.send("🚀 Polex VTU API is running successfully!"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// ✅ Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`⚡ Server running on port ${PORT}`));
