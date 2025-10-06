const express = require("express");
const cors = require("cors");
require("dotenv").config();
const db = require("./config/db"); // ✅ Make sure DB connection initializes

// Routes
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const walletRoutes = require("./routes/wallet");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");
const transactionRoutes = require("./routes/transaction");

const app = express();

// ✅ CORS setup — allow your frontend(s)
app.use(
  cors({
    origin: [
      "http://localhost:3000",        // Local development
      "https://polexvtu.vercel.app",  // Vercel frontend
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json());

// ✅ Confirm DB connection at startup
db.getConnection()
  .then(() => console.log("✅ MySQL Connected"))
  .catch((err) => console.error("❌ Database Connection Failed:", err));

// ✅ API routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);
app.use("/api/transactions", transactionRoutes);

// ✅ Root + Health
app.get("/", (req, res) => res.send("🚀 Polex VTU API is running successfully!"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// ✅ Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`⚡ Server running on port ${PORT}`));
