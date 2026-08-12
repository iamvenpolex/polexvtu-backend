"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/db");
const adminAuth = require("../middleware/adminAuth");

// ─────────────────────────────────────────────────────────────
// POST /api/admin/wallet/fund
// amount > 0  → type = 'deposit'  (credit)
// amount < 0  → type = 'debit'    (deduct)
// Body: { user_id, amount, note }
// ─────────────────────────────────────────────────────────────
router.post("/wallet/fund", adminAuth, async (req, res) => {
  const { user_id, amount, note } = req.body;
  const numAmount = Number(amount);

  if (!user_id || amount === undefined || amount === null || isNaN(numAmount) || numAmount === 0) {
    return res.status(400).json({ error: "user_id and a non-zero amount are required" });
  }

  try {
    const users = await db`
      SELECT id, first_name, last_name, balance
      FROM users
      WHERE id = ${user_id} AND deleted = FALSE
    `;

    if (!users.length) return res.status(404).json({ error: "User not found" });

    const user          = users[0];
    const balanceBefore = Number(user.balance);
    const balanceAfter  = balanceBefore + numAmount;

    if (balanceAfter < 0) {
      return res.status(400).json({
        error: `Cannot deduct ₦${Math.abs(numAmount).toLocaleString()} — user only has ₦${balanceBefore.toLocaleString()}`,
      });
    }

    const isDeposit   = numAmount > 0;
    const type        = isDeposit ? "deposit" : "debit";
    const absAmount   = Math.abs(numAmount);
    const reference   = `${isDeposit ? "DEP" : "DEB"}-ADMIN-${Date.now()}`;
    const description = note?.trim() || (isDeposit ? "Manual deposit by admin" : "Manual debit by admin");

    await db`UPDATE users SET balance = ${balanceAfter} WHERE id = ${user_id}`;

    await db`
      INSERT INTO transactions (
        user_id, reference, type, amount, status,
        description, balance_before, balance_after, via,
        amount_paid, settlement_fee, settlement_amount,
        created_at, updated_at
      ) VALUES (
        ${user_id}, ${reference}, ${type}, ${absAmount}, 'success',
        ${description}, ${balanceBefore}, ${balanceAfter}, 'admin',
        ${absAmount}, 0, ${absAmount},
        NOW(), NOW()
      )
    `;

    res.json({
      success: true,
      message: `${isDeposit ? "Deposit" : "Debit"} of ₦${absAmount.toLocaleString()} applied successfully`,
      type,
      user: `${user.first_name} ${user.last_name}`,
      amount: absAmount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
    });
  } catch (err) {
    console.error("Admin wallet fund error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;