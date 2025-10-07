const jwt = require("jsonwebtoken");
const { db } = require("../config/db");

// Middleware to verify admin token
module.exports = async function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if user exists and is admin
    const [rows] = await db.execute("SELECT id, role FROM users WHERE id = ?", [decoded.id]);

    if (!rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    if (rows[0].role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.error("Admin Auth error:", err);
    res.status(401).json({ message: "Invalid or expired token" });
  }
};
