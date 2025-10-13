"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN;
const WEBHOOK_URL = process.env.EA_WEBHOOK_URL || "https://YOUR_DEPLOYED_BACKEND_URL/buydata/webhook";

/**
 * POST /buydata
 */
router.post("/", async (req, res) => {
  const { user_id, network, mobile_no, dataplan, client_reference } = req.body;

  if (!user_id || !network || !mobile_no || !dataplan || !client_reference) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({ success: false, message: "Mobile number must be 11 digits" });
  }

  try {
    // 1️⃣ Fetch user
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    // 2️⃣ Fetch plan from DB
    const [plans] = await db.query(
      "SELECT plan_name, custom_price FROM custom_data_prices WHERE plan_id = ? AND status='active'",
      [dataplan]
    );
    if (!plans.length) return res.status(400).json({ success: false, message: "Plan not available" });
    const plan = plans[0];
    const price = Number(plan.custom_price);

    // 3️⃣ Check balance
    if (user.balance < price) {
      return res.status(400).json({ success: false, message: "Insufficient balance", user_balance: user.balance });
    }

    // 4️⃣ Deduct balance
    const balance_before = Number(user.balance);
    const balance_after = balance_before - price;
    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    // 5️⃣ Insert transaction
    await db.query(
      `INSERT INTO transactions
      (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        client_reference,
        "data",
        price,
        0,
        "pending",
        network,
        plan.plan_name,
        mobile_no,
        "wallet",
        `Data purchase of ${plan.plan_name} via wallet`,
        balance_before,
        balance_after,
      ]
    );

    // 6️⃣ Send request to EasyAccess
    const params = new URLSearchParams();
    params.append("network", network);
    params.append("mobileno", mobile_no);
    params.append("dataplan", dataplan);
    params.append("client_reference", client_reference);
    params.append("max_amount_payable", price.toString());
    params.append("webhook_url", WEBHOOK_URL);

    const eaResponse = await axios.post(BASE_URL, params.toString(), {
      headers: { AuthorizationToken: API_TOKEN, "Content-Type": "application/x-www-form-urlencoded" },
    });

    // 7️⃣ Update transaction with API amount
    if (eaResponse.data?.amount) {
      await db.query("UPDATE transactions SET api_amount = ? WHERE reference = ?", [
        eaResponse.data.amount,
        client_reference,
      ]);
    }

    return res.json({
      success: true,
      message: "Purchase initiated. Awaiting EasyAccess confirmation via webhook.",
      reference: client_reference,
      user_id: user.id,
      amount: price,
      network,
      phone: mobile_no,
      plan: plan.plan_name,
      status: "pending",
      api_response: eaResponse.data,
    });
  } catch (error) {
    console.error("Buy data error:", error.message);
    return res.status(500).json({ success: false, message: "Error purchasing data", error: error.message });
  }
});

module.exports = router;
