"use strict";

const express = require("express");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

// EasyAccess webhook for data purchases
router.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;

    const {
      client_reference,
      status,
      auto_refund_status,
      amount,
      network,
      mobileno,
      dataplan,
      message,
    } = payload;

    console.log("📩 Webhook received:", payload);

    // 1️⃣ Find the transaction
    const [transactions] = await db.query(
      "SELECT * FROM transactions WHERE reference = ? AND type='data'",
      [client_reference]
    );

    if (!transactions.length) {
      console.log("❌ Transaction not found:", client_reference);
      return res.status(404).json({ success: false, message: "Transaction not found" });
    }

    const transaction = transactions[0];

    // 2️⃣ Update transaction with EA response
    await db.query(
      "UPDATE transactions SET status = ?, api_amount = ?, message = ?, updated_at = NOW() WHERE reference = ?",
      [
        status,
        amount || transaction.api_amount,
        message || "",
        client_reference,
      ]
    );

    // 3️⃣ Handle auto-refund if EA failed
    if (auto_refund_status?.toLowerCase() === "failed") {
      console.log("💸 Auto-refund triggered for:", client_reference);

      // Refund user wallet
      const refundAmount = transaction.amount;
      const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [
        transaction.user_id,
      ]);

      if (users.length) {
        const user = users[0];
        const newBalance = parseFloat(user.balance) + parseFloat(refundAmount);

        await db.query("UPDATE users SET balance = ? WHERE id = ?", [newBalance, user.id]);

        // Log refund transaction
        await db.query(
          `INSERT INTO transactions 
          (user_id, reference, type, amount, status, network, plan, phone, via, description, balance_before, balance_after) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            transaction.user_id,
            client_reference + "_refund",
            "refund",
            refundAmount,
            "success",
            network,
            dataplan,
            mobileno,
            "auto-refund",
            `Refund for failed data purchase ${dataplan}`,
            parseFloat(user.balance),
            newBalance,
          ]
        );

        console.log(`✅ Refund successful: ₦${refundAmount} to user ${user.id}`);
      }
    }

    // 4️⃣ Respond to EasyAccess
    return res.json({ success: true, message: "Webhook processed" });
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    return res.status(500).json({ success: false, message: "Webhook error", error: error.message });
  }
});

module.exports = router;
