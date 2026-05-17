"use strict";

const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db");

const BASE_URL = "https://easyaccessapi.com.ng/api/live/v1/purchase-data";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

/**
 * BUY DATA ROUTE
 */
router.post("/", async (req, res) => {
  const {
    user_id,
    network,
    mobile_no,
    dataplan,
    client_reference,
  } = req.body;

  // =========================
  // VALIDATION
  // =========================
  if (!user_id || !network || !mobile_no || !dataplan || !client_reference) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({
      success: false,
      message: "Mobile number must be 11 digits",
    });
  }

  try {
    // =========================
    // DB TRANSACTION (LOCK USER)
    // =========================
    const result = await db.begin(async (tx) => {
      const dup = await tx`
        SELECT id FROM transactions WHERE reference = ${client_reference}
      `;
      if (dup.length) throw new Error("DUPLICATE_REFERENCE");

      const users = await tx`
        SELECT id, balance
        FROM users
        WHERE id = ${user_id}
        FOR UPDATE
      `;
      if (!users.length) throw new Error("USER_NOT_FOUND");

      const user = users[0];

      const plans = await tx`
        SELECT plan_name, custom_price
        FROM custom_data_prices
        WHERE plan_id = ${dataplan}
        AND status = 'active'
      `;
      if (!plans.length) throw new Error("PLAN_NOT_AVAILABLE");

      const plan = plans[0];
      const price = Number(plan.custom_price);

      if (Number(user.balance) < price) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const balance_before = Number(user.balance);
      const balance_after = balance_before - price;

      await tx`
        UPDATE users
        SET balance = ${balance_after}
        WHERE id = ${user.id}
      `;

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
          ${network},
          ${plan.plan_name},
          ${mobile_no},
          'wallet',
          ${"Data purchase " + plan.plan_name},
          ${balance_before},
          ${balance_after}
        )
      `;

      return { user, plan, price, balance_before };
    });

    // =========================
    // CALL EASYACCESS API
    // =========================
    let response;

    try {
      console.log("📡 Sending request to EasyAccess...");

      response = await axios.post(
        BASE_URL,
        {
          network: Number(network), // IMPORTANT FIX
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

      console.log("📡 EasyAccess Response:", response.data);
    } catch (apiErr) {
      console.error("❌ API ERROR:", apiErr.response?.data || apiErr.message);

      await db.begin(async (tx) => {
        await tx`
          UPDATE users
          SET balance = ${result.balance_before}
          WHERE id = ${result.user.id}
        `;

        await tx`
          UPDATE transactions
          SET status = 'failed',
              api_response = ${JSON.stringify({
                error: "API_REQUEST_FAILED",
                message: apiErr.message,
              })}
          WHERE reference = ${client_reference}
        `;
      });

      return res.status(502).json({
        success: false,
        message: "API error. Wallet refunded.",
      });
    }

    const ea = response.data;

    // =========================
    // STATUS HANDLING
    // =========================
    const code = Number(ea?.code);
    const status = ea?.status?.toLowerCase();

    const apiLog = {
      code,
      status,
      message: ea?.message,
      reference: ea?.reference,
      amount: ea?.amount,
      network: ea?.network,
      mobileno: ea?.mobileno,
      dataplan: ea?.dataplan,
      true_response: ea?.true_response,
      client_reference: ea?.client_reference,
      transaction_date: ea?.transaction_date,
    };

    // =========================
    // SUCCESS
    // =========================
    if (code === 200 && status === "success") {
      await db`
        UPDATE transactions
        SET status = 'success',
            api_amount = ${ea.amount || 0},
            api_response = ${JSON.stringify(apiLog)}
        WHERE reference = ${client_reference}
      `;

      return res.json({
        success: true,
        message: ea.message,
        reference: client_reference,
      });
    }

    // =========================
    // PENDING
    // =========================
    if (status === "pending") {
      await db`
        UPDATE transactions
        SET status = 'pending',
            api_response = ${JSON.stringify(apiLog)}
        WHERE reference = ${client_reference}
      `;

      return res.json({
        success: true,
        message: "Transaction is processing",
        reference: client_reference,
      });
    }

    // =========================
    // FAILED (REFUND USER)
    // =========================
    await db.begin(async (tx) => {
      await tx`
        UPDATE users
        SET balance = ${result.balance_before}
        WHERE id = ${result.user.id}
      `;

      await tx`
        UPDATE transactions
        SET status = 'failed',
            api_amount = ${ea.amount || 0},
            api_response = ${JSON.stringify(apiLog)}
        WHERE reference = ${client_reference}
      `;
    });

    return res.status(400).json({
      success: false,
      message: ea.message || "Purchase failed",
    });
  } catch (err) {
    console.error("DATA PURCHASE ERROR:", err);

    if (err.message === "DUPLICATE_REFERENCE") {
      return res.status(409).json({
        success: false,
        message: "Duplicate reference",
      });
    }

    if (err.message === "USER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (err.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
      });
    }

    if (err.message === "PLAN_NOT_AVAILABLE") {
      return res.status(404).json({
        success: false,
        message: "Plan not available",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;