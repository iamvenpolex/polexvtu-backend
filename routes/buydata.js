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
// REFUND FUNCTION
// Refund is protected by refunded = false.
// This prevents webhook + verifier from refunding twice.
// ─────────────────────────────────────────────

async function refundTransaction(reference, reason, apiResponse = {}) {
  return db.begin(async (tx) => {
    const rows = await tx`
      SELECT
        t.id,
        t.user_id,
        t.amount,
        t.status,
        t.refunded,
        t.balance_before,
        u.balance AS current_balance
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.reference = ${reference}
      FOR UPDATE OF t, u
    `;

    if (!rows.length) {
      return {
        refunded: false,
        found: false,
      };
    }

    const transaction = rows[0];

    // Already refunded/resolved
    if (transaction.refunded === true || transaction.status !== "pending") {
      return {
        refunded: false,
        found: true,
        alreadyResolved: true,
        status: transaction.status,
      };
    }

    const amount = Number(transaction.amount);
    const currentBalance = Number(transaction.current_balance);
    const newBalance = currentBalance + amount;

    await tx`
      UPDATE users
      SET balance = balance + ${amount}
      WHERE id = ${transaction.user_id}
    `;

    await tx`
      UPDATE transactions
      SET
        status = 'failed',
        refunded = true,
        balance_after = ${newBalance},
        api_response = ${JSON.stringify({
          ...apiResponse,
          refund: {
            refunded: true,
            reason,
            amount,
          },
        })},
        updated_at = NOW()
      WHERE id = ${transaction.id}
        AND status = 'pending'
        AND refunded = false
    `;

    return {
      refunded: true,
      found: true,
      amount,
      balance_after: newBalance,
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
    network === undefined ||
    network === null ||
    dataplan === undefined ||
    dataplan === null ||
    !mobile_no ||
    !client_reference
  ) {
    return res.status(400).json({
      success: false,
      status: "failed",
      message: "Missing required fields",
    });
  }

  if (!/^\d{11}$/.test(String(mobile_no))) {
    return res.status(400).json({
      success: false,
      status: "failed",
      message: "Mobile number must be 11 digits",
    });
  }

  try {
    // ─────────────────────────────────────────────
    // LOCK USER + DEDUCT WALLET + CREATE PENDING TX
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
      const currentBalance = Number(user.balance);

      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("INVALID_PLAN_PRICE");
      }

      if (currentBalance < price) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const balanceBefore = currentBalance;
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
          NULL,
          'data',
          ${price},
          0,
          'pending',
          false,
          ${String(network)},
          ${plan.plan_name},
          ${mobile_no},
          'wallet',
          ${"Data purchase " + plan.plan_name},
          ${balanceBefore},
          ${balanceAfter}
        )
      `;

      console.log("💰 Wallet deducted:", {
        reference: client_reference,
        user_id: user.id,
        amount: price,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      });

      return {
        user,
        plan,
        price,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      };
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
          timeout: 20000,
        }
      );

      console.log("📡 EasyAccess Response:", response.data);
    } catch (apiErr) {
      const providerResponse = apiErr.response?.data;

      console.error(
        "❌ EA API ERROR:",
        providerResponse || apiErr.message
      );

      // If EasyAccess actually returned a response, process it.
      // A timeout/network error is NOT automatically refunded because
      // the provider may have processed the transaction.
      if (providerResponse) {
        const ea = providerResponse;

        const code = Number(ea?.code);
        const eaStatus = normalizeStatus(ea?.status);

        const providerReference =
          ea?.reference || null;

        const apiLog = {
          source: "purchase_api_error_response",
          code,
          status: ea?.status,
          message: ea?.message,
          true_response: ea?.true_response,
          reference: providerReference,
          amount: ea?.amount,
          network: ea?.network,
          mobileno: ea?.mobileno,
          dataplan: ea?.dataplan,
          client_reference: ea?.client_reference || client_reference,
          transaction_date: ea?.transaction_date,
        };

        // Save provider reference before resolving.
        if (providerReference) {
          await db`
            UPDATE transactions
            SET
              provider_reference = ${providerReference},
              api_amount = ${Number(ea?.amount || 0)},
              api_response = ${JSON.stringify(apiLog)},
              updated_at = NOW()
            WHERE reference = ${client_reference}
          `;
        }

        // Definitive failure → refund
        if (isFailed(eaStatus) || isFailedCode(code)) {
          const refund = await refundTransaction(
            client_reference,
            "EasyAccess purchase response failed",
            apiLog
          );

          return res.status(400).json({
            success: false,
            status: "failed",
            refunded: refund.refunded || refund.alreadyResolved === true,
            message: getBestMessage(
              ea,
              "Purchase failed. Your wallet has been refunded."
            ),
            reference: client_reference,
          });
        }

        // Anything else is pending.
        return res.status(202).json({
          success: true,
          status: "pending",
          message:
            "Your transaction is being processed. We will confirm it shortly.",
          reference: client_reference,
        });
      }

      // ─────────────────────────────────────────────
      // TIMEOUT / NETWORK ERROR
      // DO NOT REFUND.
      // The provider may already have processed it.
      // Verifier/webhook will resolve it.
      // ─────────────────────────────────────────────

      await db`
        UPDATE transactions
        SET
          status = 'pending',
          api_response = ${JSON.stringify({
            source: "purchase_api",
            error: apiErr.code || "NETWORK_ERROR",
            message: apiErr.message,
          })},
          updated_at = NOW()
        WHERE reference = ${client_reference}
      `;

      return res.status(202).json({
        success: true,
        status: "pending",
        message:
          "Your transaction is being processed. We will confirm it shortly.",
        reference: client_reference,
      });
    }

    // ─────────────────────────────────────────────
    // NORMAL EASYACCESS RESPONSE
    // ─────────────────────────────────────────────

    const ea = response.data;

    const code = Number(ea?.code);
    const eaStatus = normalizeStatus(ea?.status);

    // IMPORTANT:
    // EasyAccess provider reference is NOT our client_reference.
    const providerReference =
      ea?.reference || null;

    const apiLog = {
      source: "purchase_api",
      code,
      status: ea?.status,
      message: ea?.message,
      true_response: ea?.true_response,
      reference: providerReference,
      amount: ea?.amount,
      network: ea?.network,
      mobileno: ea?.mobileno,
      dataplan: ea?.dataplan,
      client_reference:
        ea?.client_reference || client_reference,
      transaction_date: ea?.transaction_date,
    };

    // Save provider reference immediately.
    if (providerReference) {
      await db`
        UPDATE transactions
        SET
          provider_reference = ${providerReference},
          api_amount = ${Number(ea?.amount || 0)},
          api_response = ${JSON.stringify(apiLog)},
          updated_at = NOW()
        WHERE reference = ${client_reference}
      `;
    } else {
      await db`
        UPDATE transactions
        SET
          api_amount = ${Number(ea?.amount || 0)},
          api_response = ${JSON.stringify(apiLog)},
          updated_at = NOW()
        WHERE reference = ${client_reference}
      `;
    }

    // ─────────────────────────────────────────────
    // SUCCESS
    // ─────────────────────────────────────────────

    if (isSuccess(eaStatus) || isSuccessCode(code)) {
      await db`
        UPDATE transactions
        SET
          status = 'success',
          refunded = false,
          api_amount = ${Number(ea?.amount || 0)},
          api_response = ${JSON.stringify(apiLog)},
          updated_at = NOW()
        WHERE reference = ${client_reference}
          AND status = 'pending'
      `;

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
    // FAILED
    // ─────────────────────────────────────────────

    if (isFailed(eaStatus) || isFailedCode(code)) {
      const refund = await refundTransaction(
        client_reference,
        "EasyAccess returned failed status",
        apiLog
      );

      return res.status(400).json({
        success: false,
        status: "failed",
        refunded: refund.refunded || refund.alreadyResolved === true,
        message: getBestMessage(
          ea,
          "Purchase failed. Your wallet has been refunded."
        ),
        reference: client_reference,
      });
    }

    // ─────────────────────────────────────────────
    // UNKNOWN / PENDING
    // ─────────────────────────────────────────────

    await db`
      UPDATE transactions
      SET
        status = 'pending',
        updated_at = NOW()
      WHERE reference = ${client_reference}
        AND status = 'pending'
    `;

    return res.status(202).json({
      success: true,
      status: "pending",
      message:
        "Transaction is being processed. We will confirm it shortly.",
      reference: client_reference,
    });
  } catch (err) {
    console.error("DATA PURCHASE ERROR:", err);

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
// BENEFICIARIES
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
    console.error("Beneficiaries error:", err.message);

    return res.status(500).json({
      success: false,
      phones: [],
    });
  }
});

module.exports = router;