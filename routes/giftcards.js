const express = require("express");
const router = express.Router();
const cors = require("cors");
const db = require("../config/db");
const jwt = require("jsonwebtoken");
const adminAuth = require("../middleware/adminAuth");

// ------------------------
// CORS
// ------------------------
router.use(
  cors({
    origin: ["http://localhost:3000", "https://tapam.mipitech.com.ng"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ------------------------
// ADMIN: Bulk Generate Gift Cards
// ------------------------
router.post("/admin/bulk", adminAuth, async (req, res) => {
  const { amount, quantity, expires_at, description, source } = req.body;

  if (!amount || !quantity || !expires_at)
    return res.status(400).json({ message: "Missing required fields" });

  try {
    const codes = [];
    for (let i = 0; i < quantity; i++) {
      const code = Math.random().toString(36).substring(2, 12).toUpperCase();
      codes.push(code);
    }

    const insertedCards = [];
    for (const code of codes) {
      const { rows } = await db`
        INSERT INTO gift_cards (code, amount, expires_at, description, source)
        VALUES (${code}, ${amount}, ${expires_at}, ${description || "Gift Card"}, ${source || "manual"})
        RETURNING *
      `;
      insertedCards.push(rows[0]);
      console.log("Generated gift card:", rows[0]);
    }

    res.json({ message: "Bulk gift cards generated", cards: insertedCards });
  } catch (err) {
    console.error("Error generating gift cards:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------
// USER: Redeem Gift Card
// ------------------------
router.post("/redeem", async (req, res) => {
  const { code } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ message: "Not authorized" });

  const token = authHeader.split(" ")[1];
  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.id;
  } catch (err) {
    return res.status(401).json({ message: "Token invalid or expired" });
  }

  if (!code) return res.status(400).json({ message: "Code is required" });

  try {
    const { rows } = await db`
      SELECT * FROM gift_cards
      WHERE code = ${code} AND is_redeemed = FALSE AND expires_at > NOW()
    `;

    if (!rows.length) {
      console.log("Invalid or expired gift card:", code);

      // Record failed attempt in history
      await db`
        INSERT INTO gift_card_history (gift_card_id, user_id, action, timestamp, balance_before, balance_after, reason)
        VALUES (NULL, ${userId}, 'failed', NOW(), NULL, NULL, 'Invalid or expired card')
      `;

      return res.status(400).json({ message: "Invalid, redeemed, or expired card" });
    }

    const card = rows[0];

    // Get user's current balance
    const userRows = await db`SELECT balance FROM users WHERE id = ${userId}`;
    const userBalance = Number(userRows[0]?.balance || 0);
    const balanceBefore = userBalance;
    const balanceAfter = userBalance + Number(card.amount);

    // Update user's balance
    await db`
      UPDATE users
      SET balance = ${balanceAfter}
      WHERE id = ${userId}
    `;

    // Mark gift card as redeemed
    await db`
      UPDATE gift_cards
      SET is_redeemed = TRUE, redeemed_by = ${userId}, redeemed_at = NOW()
      WHERE id = ${card.id}
    `;

    // Record in gift_card_history
    await db`
      INSERT INTO gift_card_history (gift_card_id, user_id, action, timestamp, balance_before, balance_after, reason)
      VALUES (${card.id}, ${userId}, 'success', NOW(), ${balanceBefore}, ${balanceAfter}, 'Redeemed gift card')
    `;

    console.log(`Gift card ${code} redeemed by user ${userId}`);
    res.json({ message: "Gift card redeemed", amount: card.amount, balanceBefore, balanceAfter });
  } catch (err) {
    console.error("Error redeeming gift card:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------
// HISTORY: Admin & User
// ------------------------
router.get("/history", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "Not authorized" });

  const token = authHeader.split(" ")[1];
  let userId;
  let isAdmin = false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.id;
    isAdmin = decoded.role === "admin";
  } catch (err) {
    return res.status(401).json({ message: "Token invalid or expired" });
  }

  try {
    let rows;
    if (isAdmin) {
      rows = await db`
        SELECT h.*, g.code, g.amount
        FROM gift_card_history h
        LEFT JOIN gift_cards g ON h.gift_card_id = g.id
        ORDER BY h.timestamp DESC
      `;
    } else {
      rows = await db`
        SELECT h.*, g.code, g.amount
        FROM gift_card_history h
        LEFT JOIN gift_cards g ON h.gift_card_id = g.id
        WHERE h.user_id = ${userId}
        ORDER BY h.timestamp DESC
      `;
    }

    console.log(`Fetched gift card history for ${isAdmin ? "admin" : "user"}:`, rows.length, "records");
    res.json(rows);
  } catch (err) {
    console.error("Error fetching gift card history:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
