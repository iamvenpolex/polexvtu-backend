"use strict";

const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db");

const BASE_URL =
  "https://easyaccessapi.com.ng/api/live/v1/purchase-data";

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getBestMessage(ea, fallback) {
  return ea?.true_response || ea?.message || fallback;
}

function isSuccessStatus(status) {
  return ["success", "successful"].includes(
    String(status || "").toLowerCase()
  );
}

function isFailedStatus(status) {
  return String(status || "").toLowerCase() === "failed";
}

function isSuccessCode(code) {
  return [200, 201].includes(Number(code));
}

function isFailedCode(code) {
  return [400, 401].includes(Number(code));
}

// ─────────────────────────────────────────────
// REFUND TRANSACTION SAFELY
// ─────────────────────────────────────────────
//
// IMPORTANT:
// This function locks the transaction and user.
// Therefore webhook + verifier cannot refund twice.
//
// It adds the refund to the CURRENT wallet balance.
// It does NOT restore balance_before.
// ─────────────────────────────────────────────

async function refundTransaction(clientReference, apiResponse) {
  return db.begin(async (tx) => {
    const rows = await tx`
      SELECT
        t.id,
        t.user_id,
        t.amount,
        t.status,
        u.balance AS current_balance
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.reference = ${clientReference}
      FOR UPDATE
    `;

    if (!rows.length) {
      throw new Error("TRANSACTION_NOT_FOUND");
    }

    const transaction = rows[0];

    // Already successful — NEVER refund
    if (transaction.status === "success") {
      return {
        refunded: false,
        alreadyResolved: true,
        status: "success",
      };
    }

    // Already failed — refund already processed
    if (transaction.status === "failed") {
      return {
        refunded: false,
        alreadyResolved: true,
        status: "failed",
      };
    }

    const refundAmount = Number(transaction.amount);
    const currentBalance = Number(transaction.current_balance);

    const balanceAfterRefund =
      currentBalance + refundAmount;

    // Add refund to CURRENT balance
    await tx`
      UPDATE users
      SET balance = balance + ${refundAmount}
      WHERE id = ${transaction.user_id}
    `;

    // Mark transaction failed
    await tx`
      UPDATE transactions
      SET
        status = 'failed',
        balance_after = ${balanceAfterRefund},
        api_response = ${JSON.stringify(apiResponse)},
        updated_at = NOW()
      WHERE id = ${transaction.id}
    `;

    return {
      refunded: true,
      alreadyResolved: false,
      status: "failed",
      amount: refundAmount,
      balanceAfterRefund,
    };
  });
}

// ─────────────────────────────────────────────
// BUY DATA
// POST /api/buydata
// ─────────────────────────────────────────────

router.post("/", async (req, res) => {
  const {
    user_id,
    network,
    mobile_no,
    dataplan,
    client_reference,
  } = req.body;

  // ─────────────────────────────────────────────
  // VALIDATION
  // ─────────────────────────────────────────────

  if (
    !user_id ||
    !network ||
    !mobile_no ||
    !dataplan ||
    !client_reference
  ) {
    return res.status(400).json({
      success: false,
      status: "failed",
      message: "Missing required fields",
    });
  }

  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({
      success: false,
      status: "failed",
      message: "Mobile number must be 11 digits",
    });
  }

  try {
    // ─────────────────────────────────────────────
    // LOCK USER → CHECK BALANCE → DEDUCT → PENDING
    // ─────────────────────────────────────────────

    const result = await db.begin(async (tx) => {
      const duplicate = await tx`
        SELECT id, status
        FROM transactions
        WHERE reference = ${client_reference}
        LIMIT 1
      `;

      if (duplicate.length) {
        throw new Error("DUPLICATE_REFERENCE");
      }

      const users = await tx`
        SELECT id, balance
        FROM users
        WHERE id = ${Number(user_id)}
        FOR UPDATE
      `;

      if (!users.length) {
        throw new Error("USER_NOT_FOUND");
      }

      const user = users[0];

      const plans = await tx`
        SELECT plan_name, custom_price
        FROM custom_data_prices
        WHERE plan_id = ${Number(dataplan)}
          AND status = 'active'
        LIMIT 1
      `;

      if (!plans.length) {
        throw new Error("PLAN_NOT_AVAILABLE");
      }

      const plan = plans[0];

      const price = Number(plan.custom_price);

      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("INVALID_PLAN_PRICE");
      }

      const balanceBefore = Number(user.balance);

      if (balanceBefore < price) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const balanceAfter = balanceBefore - price;

      // Deduct wallet
      await tx`
        UPDATE users
        SET balance = ${balanceAfter}
        WHERE id = ${user.id}
      `;

      // Create pending transaction
      await tx`
        INSERT INTO transactions (
          user_id,
          reference,
          type,
          amount,
          api_amount,
          status,
          network,
          plan,
          phone,
          via,
          description,
          balance_before,
          balance_after
        )
        VALUES (
          ${user.id},
          ${client_reference},
          'data',
          ${price},
          0,
          'pending',
          ${Number(network)},
          ${plan.plan_name},
          ${mobile_no},
          'wallet',
          ${"Data purchase " + plan.plan_name},
          ${balanceBefore},
          ${balanceAfter}
        )
      `;

      return {
        userId: user.id,
        price,
        balanceBefore,
        balanceAfter,
        plan,
      };
    });

    console.log("💰 Wallet deducted:", {
      reference: client_reference,
      user_id: result.userId,
      amount: result.price,
      balance_before: result.balanceBefore,
      balance_after: result.balanceAfter,
    });

    // ─────────────────────────────────────────────
    // CALL EASYACCESS
    // ─────────────────────────────────────────────

    let response;

    try {
      console.log("📡 Sending to EasyAccess:", {
        network: Number(network),
        dataplan: Number(dataplan),
        mobileno: mobile_no,
        client_reference,
        max_amount_payable: result.price,
      });

      response = await axios.post(
        BASE_URL,
        {
          network: Number(network),
          dataplan: Number(dataplan),
          mobileno: mobile_no,
          client_reference,
          max_amount_payable: result.price,
        },
        {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );

      console.log(
        "📡 EasyAccess Response:",
        response.data
      );
    } catch (apiErr) {
      console.error(
        "❌ EA API ERROR:",
        apiErr.response?.data || apiErr.message
      );

      // ─────────────────────────────────────────────
      // IMPORTANT:
      // DO NOT REFUND NETWORK/TIMEOUT ERRORS.
      //
      // EasyAccess could have received the request
      // and delivered the data even though our server
      // did not receive the response.
      // ─────────────────────────────────────────────

      await db`
        UPDATE transactions
        SET
          status = 'pending',
          api_response = ${JSON.stringify({
            source: "purchase_api",
            error:
              apiErr.code === "ECONNABORTED"
                ? "TIMEOUT"
                : "NETWORK_ERROR",
            message: apiErr.message,
            verification_required: true,
          })},
          updated_at = NOW()
        WHERE reference = ${client_reference}
      `;

      return res.status(202).json({
        success: true,
        status: "pending",
        message:
          "Your transaction is being processed. We will confirm the result shortly.",
        reference: client_reference,
      });
    }

    const ea = response.data;

    const code = Number(ea?.code);

    const eaStatus = String(
      ea?.status || ""
    ).toLowerCase();

    const apiLog = {
      source: "purchase_api",
      code,
      status: eaStatus,
      message: ea?.message || null,
      true_response: ea?.true_response || null,
      reference: ea?.reference || null,
      amount: ea?.amount || null,
      network: ea?.network || null,
      mobileno: ea?.mobileno || null,
      dataplan: ea?.dataplan || null,
      client_reference:
        ea?.client_reference || client_reference,
      transaction_date:
        ea?.transaction_date || null,
    };

    // ─────────────────────────────────────────────
    // SUCCESS
    // ─────────────────────────────────────────────

    if (
      isSuccessCode(code) ||
      isSuccessStatus(eaStatus)
    ) {
      await db`
        UPDATE transactions
        SET
          status = 'success',
          api_amount = ${Number(ea?.amount || 0)},
          api_response = ${JSON.stringify(apiLog)},
          updated_at = NOW()
        WHERE reference = ${client_reference}
      `;

      console.log(
        "✅ DATA PURCHASE SUCCESS:",
        client_reference
      );

      return res.json({
        success: true,
        status: "success",
        message: getBestMessage(
          ea,
          "Data purchase successful"
        ),
        reference: client_reference,
      });
    }

    // ─────────────────────────────────────────────
    // PENDING
    // ─────────────────────────────────────────────

    if (eaStatus === "pending") {
      await db`
        UPDATE transactions
        SET
          status = 'pending',
          api_response = ${JSON.stringify(apiLog)},
          updated_at = NOW()
        WHERE reference = ${client_reference}
      `;

      return res.status(202).json({
        success: true,
        status: "pending",
        message:
          "Your transaction is being processed. We will confirm the result shortly.",
        reference: client_reference,
      });
    }

    // ─────────────────────────────────────────────
    // FAILED
    // ─────────────────────────────────────────────

    if (
      isFailedCode(code) ||
      isFailedStatus(eaStatus)
    ) {
      const refund = await refundTransaction(
        client_reference,
        apiLog
      );

      console.log("💰 Refund result:", refund);

      return res.status(400).json({
        success: false,
        status: "failed",
        refunded: true,
        message:
          "Your data purchase failed. Your wallet has been refunded.",
        reference: client_reference,
      });
    }

    // ─────────────────────────────────────────────
    // UNKNOWN RESPONSE
    // ─────────────────────────────────────────────

    await db`
      UPDATE transactions
      SET
        status = 'pending',
        api_response = ${JSON.stringify({
          ...apiLog,
          verification_required: true,
          reason: "UNKNOWN_PROVIDER_RESPONSE",
        })},
        updated_at = NOW()
      WHERE reference = ${client_reference}
    `;

    return res.status(202).json({
      success: true,
      status: "pending",
      message:
        "Your transaction is being verified. We will confirm the result shortly.",
      reference: client_reference,
    });
  } catch (err) {
    console.error(
      "DATA PURCHASE ERROR:",
      err.message
    );

    const errorMap = {
      DUPLICATE_REFERENCE: {
        code: 409,
        message: "Duplicate reference",
      },

      USER_NOT_FOUND: {
        code: 404,
        message: "User not found",
      },

      INSUFFICIENT_BALANCE: {
        code: 400,
        message: "Insufficient balance",
      },

      PLAN_NOT_AVAILABLE: {
        code: 404,
        message: "Plan not available",
      },

      INVALID_PLAN_PRICE: {
        code: 400,
        message: "Invalid plan price",
      },

      TRANSACTION_NOT_FOUND: {
        code: 404,
        message: "Transaction not found",
      },
    };

    const known = errorMap[err.message];

    if (known) {
      return res.status(known.code).json({
        success: false,
        status: "failed",
        message: known.message,
      });
    }

    return res.status(500).json({
      success: false,
      status: "failed",
      message: "Internal server error",
    });
  }
});

// ─────────────────────────────────────────────
// GET BENEFICIARIES
// ─────────────────────────────────────────────

router.get("/beneficiaries", async (req, res) => {
  const { user_id, type } = req.query;

  if (!user_id) {
    return res.status(400).json({
      success: false,
      message: "user_id is required",
    });
  }

  try {
    const rows = await db`
      SELECT phone
      FROM (
        SELECT
          phone,
          MAX(created_at) AS last_used
        FROM transactions
        WHERE user_id = ${Number(user_id)}
          AND status = 'success'
          AND type = ${type || "data"}
          AND phone IS NOT NULL
          AND phone != ''
        GROUP BY phone
      ) sub
      ORDER BY last_used DESC
      LIMIT 6
    `;

    return res.json({
      success: true,
      phones: rows.map((r) => r.phone),
    });
  } catch (err) {
    console.error(
      "Beneficiaries error:",
      err.message
    );

    return res.status(500).json({
      success: false,
      phones: [],
    });
  }
});

module.exports = router;