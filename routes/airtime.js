"use strict";

require("dotenv").config();

const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

const API_KEY = process.env.API_247_KEY;
const BASE_URL = "https://247api.com.ng/api";

const CASHBACK_RATE = 0.01;
const MIN_AIRTIME = 50;
const MAX_AIRTIME = 50000;

// =====================================================
// NETWORKS
// Provider IDs must match 247API
// =====================================================

const NETWORKS = {
  "1": {
    id: 1,
    name: "MTN",
    prefixes: ["0703", "0706", "0803", "0806", "0810", "0813"],
  },

  "2": {
    id: 2,
    name: "Airtel",
    prefixes: ["0802", "0808", "0708", "0812", "0701"],
  },

  "3": {
    id: 3,
    name: "Glo",
    prefixes: ["0805", "0807", "0705", "0815", "0811"],
  },

  "4": {
    id: 4,
    name: "9mobile",
    prefixes: ["0809", "0818", "0817", "0908", "0909"],
  },
};

// =====================================================
// AUTH
// =====================================================

const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      message: "Not authorized",
    });
  }

  const parts = authHeader.split(" ");

  if (parts.length !== 2) {
    return res.status(401).json({
      success: false,
      message: "Invalid authorization format",
    });
  }

  const token = parts[1];

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Token invalid or expired. Log in again",
    });
  }
};

// =====================================================
// STATUS NORMALIZER
// =====================================================

function mapTransactionStatus(apiResponse) {
  const status = String(apiResponse?.status || "").toLowerCase();

  if (status === "success") {
    return "success";
  }

  if (status === "pending") {
    return "pending";
  }

  if (
    status === "failed" ||
    status === "fail" ||
    status === "failure"
  ) {
    return "failed";
  }

  return "failed";
}

// =====================================================
// GENERATE OUR INTERNAL REFERENCE
// =====================================================

function generateReference() {
  return `AIRTIME_${Date.now()}_${Math.floor(
    Math.random() * 100000
  )}`;
}

// =====================================================
// VALIDATE NETWORK + PHONE
// =====================================================

function validateNetworkAndPhone(network, phone) {
  const networkKey = String(network);

  const selectedNetwork = NETWORKS[networkKey];

  if (!selectedNetwork) {
    return {
      valid: false,
      message: "Invalid network selected",
    };
  }

  if (!/^\d{11}$/.test(phone)) {
    return {
      valid: false,
      message: "Phone number must be 11 digits",
    };
  }

  const prefix = phone.substring(0, 4);

  if (!selectedNetwork.prefixes.includes(prefix)) {
    return {
      valid: false,
      message: `The phone number does not belong to ${selectedNetwork.name}`,
    };
  }

  return {
    valid: true,
    network: selectedNetwork,
  };
}

// =====================================================
// BUY AIRTIME
// POST /api/airtime/buy
// =====================================================

router.post("/buy", protect, async (req, res) => {
  let reference = null;

  try {
    const {
      network,
      amount,
      phone,
      bypass = false,
      plan_type = "VTU",
    } = req.body;

    // -----------------------------------------------
    // VALIDATION
    // -----------------------------------------------

    if (!network || !amount || !phone) {
      return res.status(400).json({
        success: false,
        message: "network, amount and phone are required",
      });
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount)) {
      return res.status(400).json({
        success: false,
        message: "Invalid airtime amount",
      });
    }

    if (numericAmount < MIN_AIRTIME) {
      return res.status(400).json({
        success: false,
        message: `Minimum airtime amount is ₦${MIN_AIRTIME.toLocaleString()}`,
      });
    }

    if (numericAmount > MAX_AIRTIME) {
      return res.status(400).json({
        success: false,
        message: `Maximum airtime amount is ₦${MAX_AIRTIME.toLocaleString()}`,
      });
    }

    // -----------------------------------------------
    // NETWORK + PHONE CHECK
    // -----------------------------------------------

    const validation = validateNetworkAndPhone(
      network,
      phone
    );

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.message,
      });
    }

    const selectedNetwork = validation.network;

    // -----------------------------------------------
    // GET USER
    // -----------------------------------------------

    const users = await db`
      SELECT id, balance
      FROM users
      WHERE id = ${req.user.id}
      LIMIT 1
    `;

    const user = users[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const balanceBefore = Number(user.balance);

    if (balanceBefore < numericAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance",
      });
    }

    // -----------------------------------------------
    // CASHBACK
    // -----------------------------------------------

    const cashback = Math.floor(
      numericAmount * CASHBACK_RATE
    );

    const balanceAfter = balanceBefore - numericAmount;

    // -----------------------------------------------
    // INTERNAL REFERENCE
    // -----------------------------------------------

    reference = generateReference();

    // -----------------------------------------------
    // DEDUCT WALLET + CREATE PENDING TRANSACTION
    // -----------------------------------------------

    await db.begin(async (sql) => {
      await sql`
        UPDATE users
        SET balance = ${balanceAfter}
        WHERE id = ${req.user.id}
      `;

      await sql`
        INSERT INTO transactions (
          user_id,
          reference,
          provider_reference,
          type,
          amount,
          status,
          refunded,
          created_at,
          api_amount,
          network,
          phone,
          via,
          description,
          balance_before,
          balance_after
        )
        VALUES (
          ${req.user.id},
          ${reference},
          NULL,
          'airtime',
          ${numericAmount},
          'pending',
          false,
          NOW(),
          ${numericAmount},
          ${selectedNetwork.id},
          ${phone},
          'wallet',
          ${`Airtime purchase for ${phone}`},
          ${balanceBefore},
          ${balanceAfter}
        )
      `;
    });

    // -----------------------------------------------
    // CALL 247API
    // -----------------------------------------------

    let apiResponse;

    try {
      apiResponse = await axios.post(
        `${BASE_URL}/airtime`,
        {
          network: selectedNetwork.id,
          phone,
          amount: String(numericAmount),
          bypass,
          "request-id": reference,
          plan_type,
        },
        {
          headers: {
            Authorization: `Token ${API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );
    } catch (apiError) {
      console.error(
        "247API AIRTIME ERROR:",
        apiError.response?.data || apiError.message
      );

      // ---------------------------------------------
      // PROVIDER REQUEST FAILED
      // REFUND USER
      // ---------------------------------------------

      await db.begin(async (sql) => {
        await sql`
          UPDATE users
          SET balance = ${balanceBefore}
          WHERE id = ${req.user.id}
        `;

        await sql`
          UPDATE transactions
          SET
            status = 'failed',
            refunded = true,
            api_response = ${JSON.stringify(
              apiError.response?.data || {
                error: apiError.message,
              }
            )},
            balance_after = ${balanceBefore},
            updated_at = NOW()
          WHERE reference = ${reference}
            AND user_id = ${req.user.id}
        `;
      });

      return res.status(500).json({
        success: false,
        status: "failed",
        message: "Provider unavailable. Wallet refunded.",
        reference,
      });
    }

    const raw = apiResponse.data;

    console.log("247API AIRTIME RESPONSE:", raw);

    // ---------------------------------------------
    // PROVIDER REQUEST ID
    // ---------------------------------------------

    const providerReference =
      raw?.["request-id"] ||
      raw?.request_id ||
      null;

    // ---------------------------------------------
    // SAVE PROVIDER REFERENCE
    // ---------------------------------------------

    await db`
      UPDATE transactions
      SET
        provider_reference = ${providerReference},
        api_response = ${JSON.stringify(raw)},
        api_amount = ${raw?.amount || numericAmount},
        updated_at = NOW()
      WHERE reference = ${reference}
        AND user_id = ${req.user.id}
    `;

    const finalStatus = mapTransactionStatus(raw);

    // =================================================
    // SUCCESS
    // =================================================

    if (finalStatus === "success") {
      const balanceAfterCashback =
        balanceAfter + cashback;

      await db.begin(async (sql) => {
        // Credit cashback
        await sql`
          UPDATE users
          SET balance = ${balanceAfterCashback}
          WHERE id = ${req.user.id}
        `;

        // Complete main transaction
        await sql`
          UPDATE transactions
          SET
            status = 'success',
            provider_reference = ${providerReference},
            api_amount = ${raw?.amount || numericAmount},
            api_response = ${JSON.stringify({
              ...raw,
              cashback_applied: cashback,
            })},
            balance_after = ${balanceAfterCashback},
            updated_at = NOW()
          WHERE reference = ${reference}
            AND user_id = ${req.user.id}
            AND status = 'pending'
        `;

        // Cashback transaction
        if (cashback > 0) {
          await sql`
            INSERT INTO transactions (
              user_id,
              reference,
              provider_reference,
              type,
              amount,
              status,
              refunded,
              created_at,
              api_amount,
              network,
              phone,
              via,
              description,
              balance_before,
              balance_after
            )
            SELECT
              ${req.user.id},
              ${`CASHBACK_${reference}`},
              ${providerReference},
              'cashback',
              ${cashback},
              'success',
              false,
              NOW(),
              ${cashback},
              ${selectedNetwork.id},
              ${phone},
              'cashback',
              ${`1% cashback on airtime for ${phone}`},
              ${balanceAfter},
              ${balanceAfterCashback}
            WHERE NOT EXISTS (
              SELECT 1
              FROM transactions
              WHERE reference = ${`CASHBACK_${reference}`}
            )
          `;
        }
      });

      return res.json({
        success: true,
        status: "success",
        message:
          raw?.message ||
          "Airtime purchase successful",
        reference,
        provider_reference: providerReference,
        transaction_status: "success",
        cashback,
        api_response: raw,
      });
    }

    // =================================================
    // PENDING
    // =================================================

    if (finalStatus === "pending") {
      await db`
        UPDATE transactions
        SET
          status = 'pending',
          provider_reference = ${providerReference},
          api_amount = ${raw?.amount || numericAmount},
          api_response = ${JSON.stringify(raw)},
          updated_at = NOW()
        WHERE reference = ${reference}
          AND user_id = ${req.user.id}
      `;

      return res.json({
        success: true,
        status: "pending",
        message:
          raw?.message ||
          "Transaction is being processed",
        reference,
        provider_reference: providerReference,
        transaction_status: "pending",
        cashback: 0,
        api_response: raw,
      });
    }

    // =================================================
    // FAILED
    // =================================================

    await db.begin(async (sql) => {
      await sql`
        UPDATE users
        SET balance = ${balanceBefore}
        WHERE id = ${req.user.id}
      `;

      await sql`
        UPDATE transactions
        SET
          status = 'failed',
          refunded = true,
          provider_reference = ${providerReference},
          api_amount = ${raw?.amount || 0},
          api_response = ${JSON.stringify(raw)},
          balance_after = ${balanceBefore},
          updated_at = NOW()
        WHERE reference = ${reference}
          AND user_id = ${req.user.id}
      `;
    });

    return res.status(400).json({
      success: false,
      status: "failed",
      message:
        raw?.message ||
        "Airtime purchase failed. Wallet refunded.",
      reference,
      provider_reference: providerReference,
      transaction_status: "failed",
      cashback: 0,
      api_response: raw,
    });
  } catch (error) {
    console.error(
      "BUY AIRTIME ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// =====================================================
// BENEFICIARIES
// GET /api/airtime/beneficiaries
// =====================================================

router.get(
  "/beneficiaries",
  protect,
  async (req, res) => {
    try {
      const rows = await db`
        SELECT phone
        FROM (
          SELECT
            phone,
            MAX(created_at) AS last_used
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

      return res.json({
        success: true,
        phones: rows.map((row) => row.phone),
      });
    } catch (error) {
      console.error(
        "BENEFICIARIES ERROR:",
        error.message
      );

      return res.status(500).json({
        success: false,
        phones: [],
      });
    }
  }
);

// =====================================================
// NETWORKS
// GET /api/airtime/networks
// =====================================================

router.get(
  "/networks",
  protect,
  async (req, res) => {
    try {
      const response = await axios.get(
        `${BASE_URL}/get-networks?service=airtime`,
        {
          headers: {
            Authorization: `Token ${API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );

      return res.json({
        success: true,
        data: response.data,
      });
    } catch (error) {
      console.error(
        "GET NETWORKS ERROR:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to fetch networks",
      });
    }
  }
);

module.exports = router;