// middleware/authMiddleware.js
const jwt = require("jsonwebtoken");
const db = require("../config/db"); // Postgres.js client
require("dotenv").config();

// Middleware to protect routes
async function protect(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided. Log in again" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Optional: verify user exists in DB
    const rows = await db`
      SELECT id, email, first_name FROM users WHERE id = ${decoded.id}
    `;

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ Auth middleware error:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = { protect };
