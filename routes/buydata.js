"use strict";

const express = require("express");
const axios = require("axios");
const qs = require("qs");
const db = require("../config/db"); // Your MySQL connection
const router = express.Router();

const EASYACCESS_URL = "https://easyaccessapi.com.ng/api/data.php";
const EASYACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;

/**
 * POST /buydata
 * Body: { user_id, network, mobile_no, dataplan }
 */
router.post("/", async (req, res) => {
  const { user_id, network, mobile_no, dataplan } = req.body;

  if (!user_id || !network || !mobile_no || !dataplan) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    // 1️⃣ Fetch user
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    // 2️⃣ Fetch plan
    const [plans] = await db.query(
      "SELECT plan_id, plan_name, custom_price FROM custom_data_prices WHERE plan_id = ? AND status='active'",
      [dataplan]
    );
    if (!plans.length) return res.status(400).json({ success: false, message: "Plan not available" });
    const plan = plans[0];
    const price = parseFloat(plan.custom_price);

    // 3️⃣ Check balance
    if (user.balance < price) {
      return res.status(400).json({ success: false, message: "Insufficient balance", user_balance: user.balance, price });
    }

    // 4️⃣ Deduct balance & store transaction
    const reference = `CL${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const balance_before = parseFloat(user.balance);
    const balance_after = balance_before - price;

    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    await db.query(
      `INSERT INTO transactions
      (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after)
      VALUES (?, ?, 'data', ?, 0, 'pending', ?, ?, ?, 'wallet', ?, ?, ?)`,
      [user.id, reference, price, network, plan.plan_name, mobile_no, `Data purchase: ${plan.plan_name}`, balance_before, balance_after]
    );

    // 5️⃣ Prepare EasyAccess payload
    const payload = qs.stringify({
      network,
      mobileno: mobile_no,
      dataplan,
      client_reference: reference,
      max_amount_payable: price.toString(),
      webhook_url: "https://your-backend-domain.com/api/buydata/webhook" // <-- replace with your live webhook
    });

    // 6️⃣ Send request to EasyAccess
    const response = await axios.post(EASYACCESS_URL, payload, {
      headers: {
        AuthorizationToken: EASYACCESS_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
        "cache-control": "no-cache"
      },
      timeout: 15000
    });

    return res.json({
      success: true,
      message: "Purchase initiated",
      reference,
      user_id: user.id,
      amount: price,
      network,
      phone: mobile_no,
      plan: plan.plan_name,
      status: "pending",
      api_response: response.data
    });
  } catch (error) {
    console.error("BuyData Error:", error);
    return res.status(500).json({ success: false, message: "Error purchasing data", error: error.message });
  }
});

/**
 * POST /buydata/webhook
 * Handles EasyAccess callbacks
 */
router.post("/webhook", async (req, res) => {
  const { client_reference, status, amount } = req.body;

  if (!client_reference) return res.status(400).json({ success: false, message: "No client_reference provided" });

  try {
    const [transactions] = await db.query("SELECT * FROM transactions WHERE reference = ?", [client_reference]);
    if (!transactions.length) return res.status(404).json({ success: false, message: "Transaction not found" });

    const transaction = transactions[0];

    if (amount) {
      await db.query("UPDATE transactions SET api_amount = ? WHERE id = ?", [amount, transaction.id]);
    }

    if (status === "success") {
      await db.query("UPDATE transactions SET status = 'success' WHERE id = ?", [transaction.id]);
    } else if (status === "failed") {
      await db.query("UPDATE transactions SET status = 'failed' WHERE id = ?", [transaction.id]);
      // Refund user
      await db.query("UPDATE users SET balance = balance + ? WHERE id = ?", [transaction.amount, transaction.user_id]);
    }

    return res.json({ success: true, message: "Webhook processed" });
  } catch (err) {
    console.error("Webhook Error:", err);
    return res.status(500).json({ success: false, message: "Error processing webhook", error: err.message });
  }
});

module.exports = router;
