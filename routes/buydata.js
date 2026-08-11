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

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isSuccess(status) {
  return ["success", "successful"].includes(normalizeStatus(status));
}

function isFailed(status) {
  return normalizeStatus(status) === "failed";
}

function isSuccessCode(code) {
  return [200, 201].includes(Number(code));
}

function isFailedCode(code) {
  return [400, 401].includes(Number(code));
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
    // ─────────────────────────────────────────
    // 1. LOCK USER + DEDUCT WALLET
    // ─────────────────────────────────────────

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
        WHERE id = ${user_id}
        FOR UPDATE
      `;

      if (!users.length) {
        throw new Error("USER_NOT_FOUND");
      }

      const user = users[0];

      const plans = await tx`
        SELECT plan_name, custom_price
        FROM custom_data_prices
        WHERE plan_id = ${dataplan}
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

      if (Number(user.balance) < price) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const balanceBefore = Number(user.balance);
      const balanceAfter = balanceBefore - price;

      await tx`
        UPDATE users
        SET balance = ${balanceAfter}
        WHERE id = ${user.id}
      `;

      await tx`
        INSERT INTO transactions (
          user_id,
          reference,
          api_reference,
          provider_reference,
          type,
          amount,
          api_amount,
          status,
          refunded,
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
          ${client_reference},
          NULL,
          'data',
          ${price},
          0,
          'pending',
          FALSE,
          ${network},
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
        plan,
        price,
        balanceBefore,
        balanceAfter,
      };
    });

    console.log("💰 Wallet deducted:", {
      reference: client_reference,
      user_id: result.userId,
      amount: result.price,
      balance_before: result.balanceBefore,
      balance_after: result.balanceAfter,
    });

    // ─────────────────────────────────────────
    // 2. CALL EASYACCESS
    //
    // IMPORTANT:
    // validateStatus prevents Axios from throwing
    // when EasyAccess returns 400.
    // ─────────────────────────────────────────

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

          // IMPORTANT
          // Do not throw automatically on 400/401.
          validateStatus: () => true,
        }
      );

      console.log("📡 EasyAccess Response:", response.data);
    } catch (apiErr) {
      // ───────────────────────────────────────
      // TRUE NETWORK / TIMEOUT ERROR
      // We cannot know whether EA received it.
      // Leave pending.
      // ───────────────────────────────────────

      const isTimeout =
        apiErr.code === "ECONNABORTED" ||
        apiErr.code === "ETIMEDOUT" ||
        apiErr.message?.toLowerCase().includes("timeout");

      console.error(
        `❌ EA NETWORK ERROR (${isTimeout ? "TIMEOUT" : "NETWORK"}):`,
        apiErr.message
      );

      await db`
        UPDATE transactions
        SET
          status = 'pending',
          api_response = ${JSON.stringify({
            source: "purchase_api",
            error: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
            message: apiErr.message,
          })},
          updated_at = NOW()
        WHERE reference = ${client_reference}
          AND status = 'pending'
      `;

      return res.status(202).json({
        success: true,
        status: "pending",
        message:
          "Your transaction is being processed. We will confirm it shortly.",
        reference: client_reference,
      });
    }

    const ea = response.data || {};

    const code = Number(ea.code);

    const eaStatus = normalizeStatus(ea.status);
    const retrievedStatus = normalizeStatus(ea.retrieved_status);

    // EasyAccess provider reference.
    const providerReference =
      ea.reference ||
      ea.provider_reference ||
      null;

    // EasyAccess client/API reference.
    const apiReference =
      ea.client_reference ||
      client_reference;

    const apiLog = {
      source: "purchase_api",
      code,
      status: ea.status || null,
      retrieved_status: ea.retrieved_status || null,
      message: ea.message || null,
      true_response: ea.true_response || null,
      reference: ea.reference || null,
      provider_reference: providerReference,
      client_reference: ea.client_reference || null,
      api_reference: apiReference,
      amount: ea.amount ?? null,
      network: ea.network || null,
      mobileno: ea.mobileno || null,
      dataplan: ea.dataplan || null,
      transaction_date: ea.transaction_date || null,
    };

    // ─────────────────────────────────────────
    // 3. SAVE PROVIDER REFERENCE IMMEDIATELY
    // ─────────────────────────────────────────

    await db`
      UPDATE transactions
      SET
        provider_reference = ${providerReference},
        api_reference = ${apiReference},
        api_amount = ${ea.amount ?? 0},
        api_response = ${JSON.stringify(apiLog)},
        updated_at = NOW()
      WHERE reference = ${client_reference}
    `;

    // ─────────────────────────────────────────
    // 4. SUCCESS
    // ─────────────────────────────────────────

    if (
      isSuccess(eaStatus) ||
      isSuccess(retrievedStatus) ||
      isSuccessCode(code)
    ) {
      await db`
        UPDATE transactions
        SET
          status = 'success',
          provider_reference = ${providerReference},
          api_reference = ${apiReference},
          api_amount = ${ea.amount ?? 0},
          api_response = ${JSON.stringify(apiLog)},
          updated_at = NOW()
        WHERE reference = ${client_reference}
      `;

      console.log(
        `✅ EasyAccess SUCCESS: ${client_reference} → ${providerReference}`
      );

      return res.json({
        success: true,
        status: "success",
        message: getBestMessage(
          ea,
          "Data purchase successful"
        ),
        reference: client_reference,
        provider_reference: providerReference,
      });
    }

    // ─────────────────────────────────────────
    // 5. FAILED
    //
    // Refund exactly once.
    // ─────────────────────────────────────────

    if (
      isFailed(eaStatus) ||
      isFailed(retrievedStatus) ||
      isFailedCode(code)
    ) {
      const refundResult = await db.begin(async (tx) => {
        const rows = await tx`
          SELECT
            t.id,
            t.user_id,
            t.amount,
            t.status,
            t.refunded,
            u.balance
          FROM transactions t
          JOIN users u ON u.id = t.user_id
          WHERE t.reference = ${client_reference}
          FOR UPDATE OF t, u
        `;

        if (!rows.length) {
          throw new Error("TRANSACTION_NOT_FOUND");
        }

        const transaction = rows[0];

        // Already refunded/resolved.
        if (
          transaction.refunded === true ||
          transaction.status === "failed"
        ) {
          return {
            alreadyResolved: true,
            balance: Number(transaction.balance),
          };
        }

        const amount = Number(transaction.amount);
        const currentBalance = Number(transaction.balance);
        const refundedBalance = currentBalance + amount;

        await tx`
          UPDATE users
          SET balance = balance + ${amount}
          WHERE id = ${transaction.user_id}
        `;

        await tx`
          UPDATE transactions
          SET
            status = 'failed',
            refunded = TRUE,
            provider_reference = ${providerReference},
            api_reference = ${apiReference},
            api_amount = ${ea.amount ?? 0},
            balance_after = ${refundedBalance},
            api_response = ${JSON.stringify(apiLog)},
            updated_at = NOW()
          WHERE id = ${transaction.id}
        `;

        return {
          alreadyResolved: false,
          balance: refundedBalance,
        };
      });

      console.log(
        `❌ EasyAccess FAILED: ${client_reference} → REFUNDED`
      );

      return res.status(400).json({
        success: false,
        status: "failed",
        refunded: true,
        message:
          getBestMessage(
            ea,
            "Purchase failed. Your wallet has been refunded."
          ),
        reference: client_reference,
        provider_reference: providerReference,
      });
    }

    // ─────────────────────────────────────────
    // 6. UNKNOWN / PENDING
    // ─────────────────────────────────────────

    await db`
      UPDATE transactions
      SET
        status = 'pending',
        provider_reference = ${providerReference},
        api_reference = ${apiReference},
        api_response = ${JSON.stringify(apiLog)},
        updated_at = NOW()
      WHERE reference = ${client_reference}
    `;

    return res.status(202).json({
      success: true,
      status: "pending",
      message:
        "Transaction is being processed. We will confirm it shortly.",
      reference: client_reference,
      provider_reference: providerReference,
    });
  } catch (err) {
    console.error("❌ DATA PURCHASE ERROR:", err);

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
        message: "Invalid data plan price",
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
    console.error("❌ Beneficiaries error:", err.message);

    return res.status(500).json({
      success: false,
      phones: [],
    });
  }
});

module.exports = router;