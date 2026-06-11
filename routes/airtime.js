require("dotenv").config();
const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

const API_KEY = process.env.API_247_KEY;
const BASE_URL = "https://247api.com.ng/api";

const CASHBACK_RATE = 0.01; // 1%

// ================================
// AUTH MIDDLEWARE
// ================================
const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: "Not authorized" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, message: "Not authorized" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Token invalid or expired" });
  }
};

// ================================
// MAP API STATUS
// ================================
function mapTransactionStatus(apiResponse) {
  const status = apiResponse?.status?.toString()?.toLowerCase();
  if (status === "success") return "success";
  if (status === "pending") return "pending";
  return "failed";
}

// ================================
// BUY AIRTIME
// ================================
router.post("/buy", protect, async (req, res) => {
  try {
    const { network, amount, phone, bypass = false, plan_type = "VTU" } = req.body;

    // ── Validation ──────────────────────────────
    if (!network || !amount || !phone) {
      return res.status(400).json({ success: false, message: "network, amount and phone are required" });
    }

    if (!/^\d{11}$/.test(phone)) {
      return res.status(400).json({ success: false, message: "Phone number must be 11 digits" });
    }

    const numericAmount = Number(amount);
    if (numericAmount < 50) {
      return res.status(400).json({ success: false, message: "Minimum airtime amount is ₦50" });
    }

    // ── Get user ────────────────────────────────
    const [user] = await db`
      SELECT id, balance FROM users WHERE id = ${req.user.id}
    `;
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (Number(user.balance) < numericAmount) {
      return res.status(400).json({ success: false, message: "Insufficient wallet balance" });
    }

    // ── Compute cashback ────────────────────────
    // User is charged full amount, gets 1% back on success
    const cashback = Math.floor(numericAmount * CASHBACK_RATE); // floor to avoid fractions
    const balanceBefore = Number(user.balance);
    const balanceAfter = balanceBefore - numericAmount;
    const requestID = "AIRTIME_" + Date.now();

    // ── DB: deduct + insert pending ─────────────
    await db.begin(async (sql) => {
      await sql`
        UPDATE users SET balance = ${balanceAfter} WHERE id = ${req.user.id}
      `;
      await sql`
        INSERT INTO transactions (
          user_id, reference, type, amount, status, created_at,
          api_amount, network, phone, via, description, balance_before, balance_after
        ) VALUES (
          ${req.user.id}, ${requestID}, 'airtime', ${numericAmount}, 'pending', NOW(),
          ${numericAmount}, ${network}, ${phone}, 'wallet',
          ${`Airtime purchase for ${phone}`}, ${balanceBefore}, ${balanceAfter}
        )
      `;
    });

    // ── Call 247API ─────────────────────────────
    let apiResponse;
    try {
      apiResponse = await axios.post(
        `${BASE_URL}/airtime`,
        { network, phone, amount: numericAmount, bypass, "request-id": requestID, plan_type },
        {
          headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
          timeout: 30000,
        }
      );
    } catch (apiErr) {
      console.error("247API ERROR:", apiErr.response?.data || apiErr.message);

      // Refund — no cashback on failure
      await db.begin(async (sql) => {
        await sql`UPDATE users SET balance = ${balanceBefore} WHERE id = ${req.user.id}`;
        await sql`
          UPDATE transactions
          SET status = 'failed',
              api_response = ${JSON.stringify(apiErr.response?.data || { error: apiErr.message })},
              updated_at = NOW()
          WHERE reference = ${requestID}
        `;
      });

      return res.status(500).json({
        success: false,
        status: "failed",
        message: "Provider unavailable. Wallet refunded.",
      });
    }

    const raw = apiResponse.data;
    console.log("247API RESPONSE:", raw);
    const finalStatus = mapTransactionStatus(raw);

    // ── SUCCESS — apply 1% cashback ─────────────
    if (finalStatus === "success") {
      const balanceAfterCashback = balanceAfter + cashback;

      await db.begin(async (sql) => {
        // Credit cashback back to wallet
        await sql`
          UPDATE users SET balance = ${balanceAfterCashback} WHERE id = ${req.user.id}
        `;

        // Update transaction with final status + cashback info
        await sql`
          UPDATE transactions
          SET status = 'success',
              api_amount = ${raw.amount || numericAmount},
              message_id = ${raw["request-id"] || null},
              api_response = ${JSON.stringify({ ...raw, cashback_applied: cashback })},
              balance_after = ${balanceAfterCashback},
              updated_at = NOW()
          WHERE reference = ${requestID}
        `;

        // Insert cashback as a separate reward transaction for audit trail
        if (cashback > 0) {
          await sql`
            INSERT INTO transactions (
              user_id, reference, type, amount, status, created_at,
              api_amount, network, phone, via, description,
              balance_before, balance_after
            ) VALUES (
              ${req.user.id},
              ${"CASHBACK_" + requestID},
              'cashback',
              ${cashback},
              'success',
              NOW(),
              ${cashback},
              ${network},
              ${phone},
              'cashback',
              ${`1% cashback on airtime for ${phone}`},
              ${balanceAfter},
              ${balanceAfterCashback}
            )
          `;
        }
      });

      return res.json({
        success: true,
        status: "success",
        message: raw.message || "Airtime purchase successful",
        reference: requestID,
        transaction_status: "success",
        cashback,
        api_response: raw,
      });
    }

    // ── PENDING — hold cashback until confirmed ──
    if (finalStatus === "pending") {
      await db`
        UPDATE transactions
        SET status = 'pending',
            api_amount = ${raw.amount || numericAmount},
            message_id = ${raw["request-id"] || null},
            api_response = ${JSON.stringify(raw)},
            updated_at = NOW()
        WHERE reference = ${requestID}
      `;

      return res.json({
        success: true,
        status: "pending",
        message: raw.message || "Transaction pending",
        reference: requestID,
        transaction_status: "pending",
        cashback: 0, // only credited on confirmed success
        api_response: raw,
      });
    }

    // ── FAILED — refund full amount ──────────────
    await db.begin(async (sql) => {
      await sql`UPDATE users SET balance = ${balanceBefore} WHERE id = ${req.user.id}`;
      await sql`
        UPDATE transactions
        SET status = 'failed',
            api_amount = ${raw.amount || 0},
            message_id = ${raw["request-id"] || null},
            api_response = ${JSON.stringify(raw)},
            updated_at = NOW()
        WHERE reference = ${requestID}
      `;
    });

    return res.status(400).json({
      success: false,
      status: "failed",
      message: raw.message || "Airtime purchase failed. Wallet refunded.",
      reference: requestID,
      transaction_status: "failed",
      api_response: raw,
    });

  } catch (err) {
    console.error("BUY AIRTIME ERROR:", err);
    return res.status(500).json({ success: false, message: "Internal server error", error: err.message });
  }
});

// ================================
// GET BENEFICIARIES
// GET /api/airtime/beneficiaries
// ================================
router.get("/beneficiaries", protect, async (req, res) => {
  try {
    const rows = await db`
      SELECT phone
      FROM (
        SELECT phone, MAX(created_at) AS last_used
        FROM transactions
        WHERE user_id = ${req.user.id}
          AND status = 'success'
          AND type = 'airtime'
          AND phone IS NOT NULL
          AND phone != ''
        GROUP BY phone
      ) sub
      ORDER BY last_used DESC
      LIMIT 6
    `;
    res.json({ success: true, phones: rows.map((r) => r.phone) });
  } catch (err) {
    console.error("Beneficiaries error:", err.message);
    res.status(500).json({ success: false, phones: [] });
  }
});

// ================================
// GET NETWORKS
// ================================
router.get("/networks", protect, async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/get-networks?service=airtime`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    return res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("GET NETWORKS ERROR:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch networks" });
  }
});

module.exports = router;