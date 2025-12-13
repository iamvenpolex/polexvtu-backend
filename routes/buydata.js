"use strict";

const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db"); // postgres.js instance

const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

router.post("/", async (req, res) => {
  const { user_id, network, mobile_no, dataplan, client_reference } = req.body;

  if (!user_id || !network || !mobile_no || !dataplan || !client_reference) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({ success: false, message: "Mobile number must be 11 digits" });
  }

  try {
    // 🔒 TRANSACTION START
    const result = await db.begin(async (tx) => {
      // Prevent duplicate reference
      const dup = await tx`
        SELECT id FROM transactions WHERE reference = ${client_reference}
      `;
      if (dup.length) {
        throw new Error("DUPLICATE_REFERENCE");
      }

      // Lock user row
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

      // Fetch plan
      const plans = await tx`
        SELECT plan_name, custom_price
        FROM custom_data_prices
        WHERE plan_id = ${dataplan}
        AND status = 'active'
      `;
      if (!plans.length) {
        throw new Error("PLAN_NOT_AVAILABLE");
      }

      const plan = plans[0];
      const price = Number(plan.custom_price);

      if (Number(user.balance) < price) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const balance_before = Number(user.balance);
      const balance_after = balance_before - price;

      // Deduct wallet
      await tx`
        UPDATE users 
        SET balance = ${balance_after}
        WHERE id = ${user.id}
      `;

      // Insert pending transaction
      await tx`
        INSERT INTO transactions (
          user_id, reference, type, amount, api_amount, status,
          network, plan, phone, via, description,
          balance_before, balance_after
        ) VALUES (
          ${user.id}, ${client_reference}, 'data', ${price}, 0, 'pending',
          ${network}, ${plan.plan_name}, ${mobile_no}, 'wallet',
          ${"Data purchase of " + plan.plan_name},
          ${balance_before}, ${balance_after}
        )
      `;

      return { user, plan, price, balance_before };
    });
    // 🔓 TRANSACTION COMMIT HERE

    // Call EasyAccess API
    const params = new URLSearchParams({
      network,
      mobileno: mobile_no,
      dataplan,
      client_reference,
      max_amount_payable: result.price.toString(),
      webhook_url: "https://polexvtu-backend.onrender.com/buydata/webhook",
    });

    let response;
    try {
      response = await axios.post(BASE_URL, params.toString(), {
        headers: {
          AuthorizationToken: API_TOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 15000,
      });
    } catch (apiErr) {
      // Refund on API failure
      await db.begin(async (tx) => {
        await tx`
          UPDATE users 
          SET balance = ${result.balance_before}
          WHERE id = ${result.user.id}
        `;
        await tx`
          UPDATE transactions 
          SET status = 'failed'
          WHERE reference = ${client_reference}
        `;
      });

      return res.status(502).json({
        success: false,
        message: "API error. Wallet refunded.",
      });
    }

    const ea = response.data;
    const status = ea?.status?.toLowerCase();

    if (status === "successful") {
      await db`
        UPDATE transactions
        SET status = 'success',
            api_amount = ${ea.amount || 0}
        WHERE reference = ${client_reference}
      `;

      return res.json({
        success: true,
        message: "Purchase successful",
        reference: client_reference,
      });
    }

    // Refund if API failed logically
    await db.begin(async (tx) => {
      await tx`
        UPDATE users 
        SET balance = ${result.balance_before}
        WHERE id = ${result.user.id}
      `;
      await tx`
        UPDATE transactions 
        SET status = 'failed',
            api_amount = ${ea.amount || 0}
        WHERE reference = ${client_reference}
      `;
    });

    return res.json({
      success: false,
      message: "Purchase failed",
    });
  } catch (err) {
    if (err.message === "DUPLICATE_REFERENCE") {
      return res.status(409).json({ success: false, message: "Duplicate reference" });
    }
    if (err.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }
    if (err.message === "USER_NOT_FOUND") {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    console.error("Buy data error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;
