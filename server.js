const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Routes
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const walletRoutes = require("./routes/wallet");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");
const transactionRoutes = require("./routes/transaction");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);
app.use("/api/transactions", transactionRoutes);

// Root route
app.get("/", (req, res) => {
  res.send("Welcome to Polex VTU API 🚀");
});

// Health check route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Start server
const PORT = process.env.PORT || 8080; // ✅ fallback port for local dev

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
