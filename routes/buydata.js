"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN; // ENV token

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
    // ----- Prevent duplicate client_reference -----
    const [existingTx] = await db.query(
      "SELECT id FROM transactions WHERE reference = ?",
      [client_reference]
    );
    if (existingTx.length) {
      return res.status(400).json({ success: false, message: "Duplicate transaction reference" });
    }

    // Fetch user
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [user_id]);
    if (!users.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const user = users[0];

    // Fetch plan price
    const [plans] = await db.query(
      "SELECT plan_id, plan_name, custom_price FROM custom_data_prices WHERE plan_id = ? AND status='active'",
      [dataplan]
    );
    if (!plans.length) {
      return res.status(400).json({ success: false, message: "Plan not available" });
    }
    const plan = plans[0];
    const price = parseFloat(plan.custom_price);

    // Check balance
    if (user.balance < price) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
        user_balance: user.balance,
        price,
      });
    }

    // Deduct balance
    const balance_before = parseFloat(user.balance);
    const balance_after = balance_before - price;
    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    // Insert transaction as pending
    await db.query(
      `INSERT INTO transactions 
        (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after) 
        VALUES (?, ?, 'data', ?, 0, 'pending', ?, ?, ?, 'wallet', ?, ?, ?)`,
      [
        user.id,
        client_reference,
        price,
        network,
        plan.plan_name,
        mobile_no,
        `Data purchase of ${plan.plan_name} via wallet`,
        balance_before,
        balance_after,
      ]
    );

    // Prepare EasyAccess request
    const params = new URLSearchParams();
    params.append("network", network);
    params.append("mobileno", mobile_no);
    params.append("dataplan", dataplan);
    params.append("client_reference", client_reference);
    params.append("max_amount_payable", price.toString());
    params.append("webhook_url", "https://polexvtu-backend-production.up.railway.app/buydata/webhook");

    console.log(`➡️ Sending request to EasyAccess [${client_reference}]:`, params.toString());

    try {
      // Send request and wait for response
      const response = await axios.post(BASE_URL, params.toString(), {
        headers: {
          "AuthorizationToken": API_TOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      console.log(`✅ EasyAccess response [${client_reference}]:`, response.data);

      const eaStatus = response.data?.status?.toLowerCase();
      const eaAmount = response.data?.amount || 0;

      if (eaStatus === "successful") {
        // Mark transaction success
        await db.query(
          "UPDATE transactions SET status='success', api_amount=? WHERE reference=?",
          [eaAmount, client_reference]
        );

        return res.json({
          success: true,
          message: "Purchase successful",
          status: "success",
          amount: price,
          network,
          phone: mobile_no,
          plan: plan.plan_name,
        });
      } else {
        // Refund wallet if failed
        await db.query("UPDATE users SET balance=? WHERE id=?", [balance_before, user.id]);
        await db.query(
          "UPDATE transactions SET status='failed', api_amount=? WHERE reference=?",
          [eaAmount, client_reference]
        );

        return res.json({
          success: false,
          message: "Purchase failed",
          status: "failed",
          amount: price,
          network,
          phone: mobile_no,
          plan: plan.plan_name,
        });
      }
    } catch (apiError) {
      console.error(`❌ EasyAccess API failed [${client_reference}]:`, apiError);

      // Refund wallet on API failure
      await db.query("UPDATE users SET balance=? WHERE id=?", [balance_before, user.id]);
      await db.query("UPDATE transactions SET status='failed' WHERE reference=?", [client_reference]);

      return res.status(500).json({
        success: false,
        message: "Purchase failed due to API error. Wallet refunded.",
        status: "failed",
        error: apiError.message,
      });
    }
  } catch (error) {
    console.error(`❌ Buy data error [${client_reference}]:`, error);
    return res.status(500).json({
      success: false,
      message: "Error purchasing data",
      status: "failed",
      error: error.message,
    });
  }
});

module.exports = router;
