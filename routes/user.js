const express = require("express");
const router = express.Router();
const db = require("../config/db");
const jwt = require("jsonwebtoken");

// Middleware to verify JWT
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.error("❌ No Authorization header or invalid format");
    return res.status(401).json({ message: "No token provided. Log in again" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.id) {
      console.error("❌ JWT decoded but missing user id:", decoded);
      return res.status(401).json({ message: "Invalid token payload" });
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ Token verification failed:", err.message);
    return res.status(401).json({ message: "Invalid or expired token. Log in again" });
  }
}

// GET /api/user/profile
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    console.log("🔹 Fetching profile for user id:", req.user.id);

    // Use db.execute(), not db.query()
    const [rows] = await db.execute(
      "SELECT id, first_name, last_name, email, phone, balance, reward FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!rows || rows.length === 0) {
      console.warn("⚠️ User not found for id:", req.user.id);
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    const profile = {
      id: user.id,
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      email: user.email || "",
      phone: user.phone || "",
      balance: Number(user.balance || 0),
      reward: Number(user.reward || 0),
    };

    console.log("✅ Profile fetched successfully:", profile);
    res.json(profile);
  } catch (err) {
    console.error("❌ Server error while fetching profile:", err);
    res.status(500).json({
      message: "Please try again later",
      error: err.message,
      stack: err.stack,
    });
  }
});

module.exports = router;
