const jwt = require("jsonwebtoken");
const db = require("../config/db"); // Postgres.js client

module.exports = async function adminAuth(req, res, next) {
  try {
    // ✅ Check authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    // ✅ Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ Check user existence
    const rows = await db`
      SELECT id, role 
      FROM users 
      WHERE id = ${decoded.id}
      LIMIT 1
    `;

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = rows[0];

    // ✅ Check admin role
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Access denied. Admin only." });
    }

    // ✅ Attach user to request object (good for controllers)
    req.user = user;

    return next();
  } catch (err) {
    console.error("❌ Admin Auth error:", err);

    // ✅ Handle JWT errors correctly
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }

    return res.status(500).json({ error: "Server error" });
  }
};
