"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/db");
const jwt = require("jsonwebtoken");

// ─────────────────────────────────────────────
// AUTH
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
// GET /api/transactions
// ─────────────────────────────────────────────

router.get("/", protect, async (req, res) => {
try {
const userId = req.user.id;


const rows = await db`
  SELECT
    id,
    reference,
    provider_reference,
    api_reference,
    type,
    amount,
    status,
    refunded,
    created_at,
    phone,
    network,
    description,
    balance_before,
    balance_after
  FROM transactions
  WHERE user_id = ${userId}
    AND type NOT IN (
      'reward-to-wallet',
      'tapam-transfer'
    )
  ORDER BY created_at DESC
`;

const transactions = rows.map((tx) => {
  const type = String(tx.type || "")
    .trim()
    .toLowerCase();

  let description = tx.description || "";
  let isCredit = false;

  // ─────────────────────────────────────────
  // CREDIT TRANSACTIONS
  // ─────────────────────────────────────────

  switch (type) {
    case "fund":
    case "deposit":
    case "cashback":
    case "receive":
    case "reward":
    case "bonus":
    case "cashback_credit":
    case "reward_credit":
      isCredit = true;
      break;

    // ───────────────────────────────────────
    // AIRTIME
    // ───────────────────────────────────────

    case "airtime":
      description =
        tx.status === "failed"
          ? "Airtime Purchase (Refunded)"
          : "Bought Airtime";

      // Failed airtime means the wallet was refunded.
      if (
        tx.status === "failed" ||
        Boolean(tx.refunded)
      ) {
        isCredit = true;
      }

      break;

    // ───────────────────────────────────────
    // DATA
    // ───────────────────────────────────────

    case "data":
      if (tx.status === "failed") {
        description =
          "Data Purchase (Refunded)";

        isCredit = true;
      } else if (tx.status === "pending") {
        description =
          "Data Purchase (Processing)";
      } else {
        description = "Bought Data";
      }

      break;

    // ───────────────────────────────────────
    // ELECTRICITY / BILLS
    // ───────────────────────────────────────

    case "electricity":
    case "bill":
    case "bill-payment":
    case "bill_payment":
      description =
        tx.status === "failed"
          ? "Bill Payment (Refunded)"
          : "Bill Payment";

      if (
        tx.status === "failed" ||
        Boolean(tx.refunded)
      ) {
        isCredit = true;
      }

      break;

    // ───────────────────────────────────────
    // TRANSFERS
    // ───────────────────────────────────────

    case "receive":
      description = "Received Transfer";
      isCredit = true;
      break;

    case "transfer":
    case "send":
      description = "Transfer";
      break;

    // ───────────────────────────────────────
    // DEFAULT
    // ───────────────────────────────────────

    default:
      description =
        tx.description ||
        tx.type ||
        "Transaction";
      break;
  }

  // ─────────────────────────────────────────
  // CASHBACK OVERRIDE
  // ─────────────────────────────────────────

  if (
    type.includes("cashback") ||
    type.includes("cash_back")
  ) {
    isCredit = true;

    description =
      tx.description ||
      "Cashback reward";
  }

  // ─────────────────────────────────────────
  // DEPOSIT OVERRIDE
  // ─────────────────────────────────────────

  if (
    type === "deposit" ||
    type === "fund"
  ) {
    isCredit = true;

    description =
      tx.description ||
      "Wallet Funded";
  }

  // ─────────────────────────────────────────
  // REFUND OVERRIDE
  // ─────────────────────────────────────────

  if (
    Boolean(tx.refunded) ||
    (
      tx.status === "failed" &&
      [
        "airtime",
        "data",
        "electricity",
        "bill",
        "bill-payment",
        "bill_payment",
      ].includes(type)
    )
  ) {
    isCredit = true;
  }

  return {
    ...tx,

    amount: Number(tx.amount),

    source: "wallet",

    description,

    isCredit,

    // Keep this for frontend compatibility
    was_refunded:
      Boolean(tx.refunded) ||
      (
        tx.status === "failed" &&
        [
          "airtime",
          "data",
          "electricity",
          "bill",
          "bill-payment",
          "bill_payment",
        ].includes(type)
      ),
  };
});

return res.json(transactions);


} catch (err) {
console.error(
"❌ Error fetching wallet transactions:",
err.message
);


return res.status(500).json({
  message: "Please try again",
});


}
});

// ─────────────────────────────────────────────
// REWARDS
// GET /api/transactions/rewards
// ─────────────────────────────────────────────

router.get("/rewards", protect, async (req, res) => {
try {
const userId = req.user.id;


const rows = await db`
  SELECT
    id,
    reference,
    provider_reference,
    api_reference,
    type,
    amount,
    status,
    refunded,
    created_at,
    phone,
    network,
    description,
    balance_before,
    balance_after
  FROM transactions
  WHERE user_id = ${userId}
    AND (
      type = 'cashback'
      OR type LIKE '%cashback%'
      OR type LIKE '%cash_back%'
    )
  ORDER BY created_at DESC
`;

return res.json(
  rows.map((tx) => ({
    ...tx,

    amount: Number(tx.amount),

    description:
      tx.description ||
      "Cashback reward",

    isCredit: true,

    source: "reward",
  }))
);


} catch (err) {
console.error(
"❌ Error fetching reward transactions:",
err.message
);


return res.status(500).json({
  message: "Please try again",
});


}
});

// ─────────────────────────────────────────────
// TAPAM
// GET /api/transactions/tapam
// ─────────────────────────────────────────────

router.get("/tapam", protect, async (req, res) => {
try {
const userId = req.user.id;


const rows = await db`
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

const transactions = rows.map((tx) => {
  let description = "";
  let isCredit = false;

  if (
    tx.sender_id === userId &&
    tx.receiver_id === userId
  ) {
    description = "Reward moved to wallet";
    isCredit = true;
  } else if (tx.sender_id === userId) {
    description =
      `Sent to ${tx.receiver_name}`;
  } else {
    description =
      `Received from ${tx.sender_name}`;

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

return res.json(transactions);


} catch (err) {
console.error(
"❌ Error fetching TapAm transactions:",
err.message
);


return res.status(500).json({
  message: "Please try again",
});


}
});

module.exports = router;
