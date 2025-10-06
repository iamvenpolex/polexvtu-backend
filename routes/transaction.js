const express = require("express");
const router = express.Router();
const db = require("../config/db");
const jwt = require("jsonwebtoken");

// ------------------------
// Middleware: Protect Routes
// ------------------------
const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "Not authorized" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Not authorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Token invalid or expired" });
  }
};

// ------------------------
// GET: User Transaction History
// ------------------------
router.get("/", protect, async (req, res) => {
  try {
    const userId = req.user.id;

   const [rows] = await db.execute(
  "SELECT id, reference, type, amount, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC",
  [userId]
);


    // Map type to description and credit/debit
    const transactions = rows.map((tx) => {
      let description = "";
      let isCredit = false;

      switch (tx.type) {
        case "fund":
          description = "Wallet Funded";
          isCredit = true;
          break;
        case "tapam-transfer":
          description = "Transferred to TamAm";
          isCredit = false;
          break;
        case "airtime":
          description = "Bought Airtime";
          isCredit = false;
          break;
        case "receive":
          description = "Received Transfer";
          isCredit = true;
          break;
        default:
          description = tx.type;
      }

      return {
        ...tx,
        description,
        isCredit,
      };
    });

    res.json(transactions);
  } catch (err) {
    console.error("Error fetching transactions:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
