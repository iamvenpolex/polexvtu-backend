"use strict";

const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db"); // ✅ postgres.js

const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

// ===== BUY DATA ROUTE =====
router.post("/", async (req, res) => {
  const { user_id, network, mobile_no, dataplan, client_reference } = req.body;

  if (!user_id || !network || !mobile_no || !dataplan || !client_reference) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({ success: false, message: "Mobile number must be 11 digits" });
  }

  try {
    // ✅ Prevent duplicate reference
    const existingTx = await db`
      SELECT id FROM transactions WHERE reference = ${client_reference}
    `;

    if (existingTx.length) {
      return res.status(400).json({ success: false, message: "Duplicate transaction reference" });
    }

    // ✅ Fetch user
    const users = await db`
      SELECT id, balance FROM users WHERE id = ${user_id}
    `;
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = users[0];

    // ✅ Fetch plan price
    const plans = await db`
      SELECT plan_id, plan_name, custom_price
      FROM custom_data_prices
      WHERE plan_id = ${dataplan} AND status = 'active'
    `;

    if (plans.length === 0) {
      return res.status(400).json({ success: false, message: "Plan not available" });
    }

    const plan = plans[0];
    const price = Number(plan.custom_price);

    // ✅ Wallet balance check
    if (Number(user.balance) < price) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
        user_balance: user.balance,
        price,
      });
    }

    const balance_before = Number(user.balance);
    const balance_after = balance_before - price;

    // ✅ Deduct wallet
    await db`
      UPDATE users SET balance = ${balance_after} WHERE id = ${user.id}
    `;

    // ✅ Insert pending transaction
    await db`
      INSERT INTO transactions (
        user_id, reference, type, amount, api_amount, status,
        network, plan, phone, via, description,
        balance_before, balance_after
      )
      VALUES (
        ${user.id}, ${client_reference}, 'data', ${price}, 0, 'pending',
        ${network}, ${plan.plan_name}, ${mobile_no}, 'wallet',
        ${"Data purchase of " + plan.plan_name + " via wallet"},
        ${balance_before}, ${balance_after}
      )
    `;

    // ✅ Prepare EasyAccess API request
    const params = new URLSearchParams();
    params.append("network", network);
    params.append("mobileno", mobile_no);
    params.append("dataplan", dataplan);
    params.append("client_reference", client_reference);
    params.append("max_amount_payable", price.toString());
    params.append(
      "webhook_url",
      "https://polexvtu-backend.onrender.com/buydata/webhook"
    );

    console.log(`➡️ Sending EasyAccess Request [${client_reference}]`);

    let response;

    try {
      response = await axios.post(BASE_URL, params.toString(), {
        headers: {
          AuthorizationToken: API_TOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
    } catch (apiErr) {
      console.error(`❌ DATA API Error [${client_reference}]`, apiErr);

      // ✅ Refund wallet on request failure
      await db`UPDATE users SET balance = ${balance_before} WHERE id = ${user.id}`;
      await db`UPDATE transactions SET status='failed' WHERE reference=${client_reference}`;

      return res.status(500).json({
        success: false,
        message: "Purchase failed due to API error. Wallet refunded.",
        error: apiErr.message,
      });
    }

    const ea = response.data;
    const eaStatus = ea?.status?.toLowerCase();
    const eaAmount = ea?.amount || 0;

    console.log(`✅ EasyAccess response [${client_reference}]`, ea);

    // ✅ If successful
    if (eaStatus === "successful") {
      await db`
        UPDATE transactions 
        SET status='success', api_amount=${eaAmount}
        WHERE reference=${client_reference}
      `;

      return res.json({
        success: true,
        message: "Purchase successful",
        status: "success",
        amount: price,
        network,
        phone: mobile_no,
        plan: plan.plan_name,
      });
    }

    // ✅ If failed - refund
    await db`UPDATE users SET balance = ${balance_before} WHERE id = ${user.id}`;
    await db`
      UPDATE transactions SET status='failed', api_amount=${eaAmount}
      WHERE reference=${client_reference}
    `;

    return res.json({
      success: false,
      message: "Purchase failed",
      status: "failed",
      amount: price,
      network,
      phone: mobile_no,
      plan: plan.plan_name,
    });
  } catch (error) {
    console.error(`❌ Buy data error [${client_reference}]`, error);
    return res.status(500).json({
      success: false,
      message: "Error purchasing data",
      error: error.message,
    });
  }
});

module.exports = router;
