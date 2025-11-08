const jwt = require("jsonwebtoken");
const db = require("../config/db"); // Postgres.js client

// Middleware to verify admin token
module.exports = async function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if user exists and is admin
    const rows = await db`
      SELECT id, role FROM users WHERE id = ${decoded.id}
    `;

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    if (rows[0].role !== "admin") {
      return res.status(403).json({ error: "Access denied. Admin only." });
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.error("❌ Admin Auth error:", err.message);
    res.status(401).json({ error: "Invalid or expired token" });
  }
};
