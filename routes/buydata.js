"use strict";

const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db");

const BASE_URL = "https://easyaccessapi.com.ng/api/live/v1/purchase-data";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

// Pick the most human-readable message from EA response
function getBestMessage(ea, fallback) {
  return ea?.true_response || ea?.message || fallback;
}

/**
 * BUY DATA ROUTE
 */
router.post("/", async (req, res) => {
  const { user_id, network, mobile_no, dataplan, client_reference } = req.body;

  // =========================
  // VALIDATION
  // =========================
  if (!user_id || !network || !mobile_no || !dataplan || !client_reference) {
    return res.status(400).json({ success: false, status: "failed", message: "Missing required fields" });
  }

  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({ success: false, status: "failed", message: "Mobile number must be 11 digits" });
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
        SELECT id, balance FROM users WHERE id = ${user_id} FOR UPDATE
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

      if (Number(user.balance) < price) throw new Error("INSUFFICIENT_BALANCE");

      const balance_before = Number(user.balance);
      const balance_after = balance_before - price;

      await tx`
        UPDATE users SET balance = ${balance_after} WHERE id = ${user.id}
      `;

      await tx`
        INSERT INTO transactions (
          user_id, reference, type, amount, api_amount, status,
          network, plan, phone, via, description, balance_before, balance_after
        ) VALUES (
          ${user.id}, ${client_reference}, 'data', ${price}, 0, 'pending',
          ${network}, ${plan.plan_name}, ${mobile_no}, 'wallet',
          ${"Data purchase " + plan.plan_name}, ${balance_before}, ${balance_after}
        )
      `;

      return { user, plan, price, balance_before };
    });

    // =========================
    // CALL EASYACCESS API
    // Per docs: network & dataplan must be integers
    // =========================
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

      console.log("📡 EasyAccess Response:", response.data);
    } catch (apiErr) {
      console.error("❌ EA API ERROR:", apiErr.response?.data || apiErr.message);

      // Refund user immediately on network/API error
      await db.begin(async (tx) => {
        await tx`
          UPDATE users SET balance = ${result.balance_before} WHERE id = ${result.user.id}
        `;
        await tx`
          UPDATE transactions
          SET status = 'failed',
              api_response = ${JSON.stringify({ error: "API_REQUEST_FAILED", message: apiErr.message })}
          WHERE reference = ${client_reference}
        `;
      });

      return res.status(502).json({
        success: false,
        status: "failed",
        message: "Could not reach provider. Your wallet has been refunded.",
      });
    }

    const ea = response.data;

    // =========================
    // STATUS HANDLING
    // Per docs: code 200 + status "success" = success
    //           status "pending" = pending
    //           anything else = failed (provider refunds on their end)
    // =========================
    const code = Number(ea?.code);
    const eaStatus = ea?.status?.toLowerCase();

    const apiLog = {
      code,
      status: eaStatus,
      message: ea?.message,
      true_response: ea?.true_response,
      reference: ea?.reference,
      amount: ea?.amount,
      network: ea?.network,
      mobileno: ea?.mobileno,
      dataplan: ea?.dataplan,
      client_reference: ea?.client_reference,
      transaction_date: ea?.transaction_date,
    };

    // =========================
    // SUCCESS
    // =========================
    if (code === 200 && eaStatus === "success") {
      await db`
        UPDATE transactions
        SET status = 'success',
            api_amount = ${ea.amount || 0},
            api_response = ${JSON.stringify(apiLog)}
        WHERE reference = ${client_reference}
      `;

      return res.json({
        success: true,
        status: "success",
        message: getBestMessage(ea, "Data purchase successful"),
        reference: client_reference,
      });
    }

    // =========================
    // PENDING
    // =========================
    if (eaStatus === "pending") {
      await db`
        UPDATE transactions
        SET status = 'pending',
            api_response = ${JSON.stringify(apiLog)}
        WHERE reference = ${client_reference}
      `;

      return res.json({
        success: true,
        status: "pending",
        message: getBestMessage(ea, "Your transaction is being processed. We'll update you shortly."),
        reference: client_reference,
      });
    }

    // =========================
    // FAILED — refund user
    // =========================
    await db.begin(async (tx) => {
      await tx`
        UPDATE users SET balance = ${result.balance_before} WHERE id = ${result.user.id}
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
      status: "failed",
      message: getBestMessage(ea, "Purchase failed. Your wallet has been refunded."),
    });

  } catch (err) {
    console.error("DATA PURCHASE ERROR:", err.message);

    const errorMap = {
      DUPLICATE_REFERENCE: { code: 409, message: "Duplicate reference" },
      USER_NOT_FOUND: { code: 404, message: "User not found" },
      INSUFFICIENT_BALANCE: { code: 400, message: "Insufficient balance" },
      PLAN_NOT_AVAILABLE: { code: 404, message: "Plan not available" },
    };

    const known = errorMap[err.message];
    if (known) {
      return res.status(known.code).json({ success: false, status: "failed", message: known.message });
    }

    return res.status(500).json({ success: false, status: "failed", message: "Internal server error" });
  }
});

// =========================
// GET BENEFICIARIES
// GET /api/buydata/beneficiaries?user_id=123&type=data
// =========================
router.get("/beneficiaries", async (req, res) => {
  const { user_id, type } = req.query;

  if (!user_id) {
    return res.status(400).json({ success: false, message: "user_id is required" });
  }

  try {
    const rows = await db`
      SELECT phone
      FROM (
        SELECT phone, MAX(created_at) AS last_used
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

    res.json({ success: true, phones: rows.map((r) => r.phone) });
  } catch (err) {
    console.error("Beneficiaries error:", err.message);
    res.status(500).json({ success: false, phones: [] });
  }
});

module.exports = router;