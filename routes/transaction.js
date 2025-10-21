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
// GET: Combined Transaction History (Wallet + Tapam + Reward)
// ------------------------
router.get("/", protect, async (req, res) => {
  try {
    const userId = req.user.id;

    // 🧾 1️⃣ Wallet Transactions
    const [walletRows] = await db.execute(
      `SELECT id, reference, type, amount, status, created_at 
       FROM transactions 
       WHERE user_id = ? 
       ORDER BY created_at DESC`,
      [userId]
    );

    const walletTransactions = walletRows.map((tx) => {
      let description = "";
      let isCredit = false;

      switch (tx.type) {
        case "fund":
          description = "Wallet Funded";
          isCredit = true;
          break;
        case "tapam-transfer":
          description = "Transferred to TapAm";
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
        source: "wallet",
        description,
        isCredit,
      };
    });

    // 💰 2️⃣ TapAm Transactions
    const [tapamRows] = await db.execute(
      `SELECT 
         id, sender_id, sender_name, sender_email, 
         receiver_id, receiver_name, receiver_email, 
         amount, reference, status, created_at
       FROM tapam_accounts
       WHERE sender_id = ? OR receiver_id = ?
       ORDER BY created_at DESC`,
      [userId, userId]
    );

    const tapamTransactions = tapamRows.map((tx) => {
      let description = "";
      let isCredit = false;

      if (tx.sender_id === userId && tx.receiver_id === userId) {
        description = "Reward moved to wallet";
        isCredit = true;
      } else if (tx.sender_id === userId) {
        description = `Sent to ${tx.receiver_name}`;
        isCredit = false;
      } else if (tx.receiver_id === userId) {
        description = `Received from ${tx.sender_name}`;
        isCredit = true;
      }

      return {
        id: tx.id,
        reference: tx.reference,
        type: "tapam",
        amount: tx.amount,
        status: tx.status,
        created_at: tx.created_at,
        sender_name: tx.sender_name,
        receiver_name: tx.receiver_name,
        description,
        isCredit,
        source: "tapam",
      };
    });

    // 🎁 3️⃣ Reward-to-Wallet Transactions
    const [rewardRows] = await db.execute(
      `SELECT id, user_id, amount, reference, status, created_at
       FROM rewards
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    const rewardTransactions = rewardRows.map((tx) => ({
      id: tx.id,
      reference: tx.reference,
      type: "reward",
      amount: tx.amount,
      status: tx.status,
      created_at: tx.created_at,
      description: "Reward credited to wallet",
      isCredit: true,
      source: "reward",
    }));

    // 🔗 Combine all
    const allTransactions = [
      ...walletTransactions,
      ...tapamTransactions,
      ...rewardTransactions,
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(allTransactions);
  } catch (err) {
    console.error("❌ Error fetching transactions:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
