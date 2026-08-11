"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/db");
const jwt = require("jsonwebtoken");

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────

const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      message: "Not authorized",
    });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      message: "Not authorized",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      message: "Token invalid or expired. Log in again",
    });
  }
};

// ─────────────────────────────────────────────
// WALLET TRANSACTIONS
// ─────────────────────────────────────────────

router.get("/", protect, async (req, res) => {
  try {
    const userId = req.user.id;

    const walletRows = await db`
      SELECT
        id,
        reference,
        provider_reference,
        type,
        amount,
        status,
        refunded,
        created_at,
        updated_at,
        phone,
        network,
        description,
        balance_before,
        balance_after
      FROM transactions
      WHERE user_id = ${userId}
        AND type NOT IN (
          'reward-to-wallet',
          'tapam-transfer',
          'cashback'
        )
      ORDER BY created_at DESC
    `;

    const walletTransactions = walletRows.map((tx) => {
      let description = "";
      let isCredit = false;

      switch (tx.type) {
        case "fund":
          description = "Wallet Funded";
          isCredit = true;
          break;

        case "airtime":
          description =
            tx.status === "failed"
              ? "Airtime Purchase (Refunded)"
              : tx.status === "pending"
              ? "Airtime Purchase (Processing)"
              : "Bought Airtime";
          break;

        case "data":
          description =
            tx.status === "failed"
              ? "Data Purchase (Refunded)"
              : tx.status === "pending"
              ? "Data Purchase (Processing)"
              : "Bought Data";
          break;

        case "receive":
          description = "Received Transfer";
          isCredit = true;
          break;

        default:
          description =
            tx.description || tx.type;
      }

      return {
        ...tx,
        amount: Number(tx.amount),
        balance_before:
          tx.balance_before !== null
            ? Number(tx.balance_before)
            : null,
        balance_after:
          tx.balance_after !== null
            ? Number(tx.balance_after)
            : null,
        source: "wallet",
        description,
        isCredit,
        was_refunded:
          tx.refunded === true,
      };
    });

    return res.json(walletTransactions);
  } catch (err) {
    console.error(
      "❌ Error fetching wallet transactions:",
      err
    );

    return res.status(500).json({
      message: "Please try again",
    });
  }
});

// ─────────────────────────────────────────────
// REWARDS / CASHBACK
// ─────────────────────────────────────────────

router.get("/rewards", protect, async (req, res) => {
  try {
    const userId = req.user.id;

    const rows = await db`
      SELECT
        id,
        reference,
        type,
        amount,
        status,
        created_at,
        description,
        phone,
        network
      FROM transactions
      WHERE user_id = ${userId}
        AND type = 'cashback'
      ORDER BY created_at DESC
    `;

    const rewards = rows.map((tx) => ({
      ...tx,
      amount: Number(tx.amount),
      description:
        tx.description || "Airtime cashback reward",
      isCredit: true,
      source: "reward",
    }));

    return res.json(rewards);
  } catch (err) {
    console.error(
      "❌ Error fetching reward transactions:",
      err
    );

    return res.status(500).json({
      message: "Please try again",
    });
  }
});

// ─────────────────────────────────────────────
// TAPAM TRANSACTIONS
// ─────────────────────────────────────────────

router.get("/tapam", protect, async (req, res) => {
  try {
    const userId = req.user.id;

    const tapamRows = await db`
      SELECT
        id,
        sender_id,
        sender_name,
        sender_email,
        receiver_id,
        receiver_name,
        receiver_email,
        amount,
        reference,
        status,
        created_at
      FROM tapam_accounts
      WHERE sender_id = ${userId}
         OR receiver_id = ${userId}
      ORDER BY created_at DESC
    `;

    const tapamTransactions = tapamRows.map((tx) => {
      let description = "";
      let isCredit = false;

      if (
        tx.sender_id === userId &&
        tx.receiver_id === userId
      ) {
        description = "Reward moved to wallet";
        isCredit = true;
      } else if (tx.sender_id === userId) {
        description = `Sent to ${tx.receiver_name}`;
      } else if (tx.receiver_id === userId) {
        description = `Received from ${tx.sender_name}`;
        isCredit = true;
      }

      return {
        id: tx.id,
        reference: tx.reference,
        type: "tapam",
        amount: Number(tx.amount),
        status: tx.status,
        created_at: tx.created_at,
        sender_name: tx.sender_name,
        receiver_name: tx.receiver_name,
        description,
        isCredit,
        source: "tapam",
      };
    });

    return res.json(tapamTransactions);
  } catch (err) {
    console.error(
      "❌ Error fetching TapAm transactions:",
      err
    );

    return res.status(500).json({
      message: "Please try again",
    });
  }
});

module.exports = router;