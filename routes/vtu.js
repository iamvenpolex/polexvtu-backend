"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const API_TOKEN = "3b2a7b74bc8bbe0878460122869864c5";
const BASE_URL = "https://easyaccessapi.com.ng/api";

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

    // 2️⃣ Fetch custom price from DB
    const [plans] = await db.query(
      "SELECT plan_name, custom_price FROM custom_data_prices WHERE plan_id = ? AND status='active'",
      [dataplan]
    );
    if (!plans.length) return res.status(400).json({ success: false, message: "Plan not available" });
    const plan = plans[0];
    const customPrice = parseFloat(plan.custom_price);

    // 3️⃣ Fetch real EA price from EasyAccess API
    const response = await axios.get(`${BASE_URL}/get_plans.php?product_type=data`, {
      headers: { AuthorizationToken: API_TOKEN },
    });

    const allPlans = [
      ...(response.data.MTN || []),
      ...(response.data.GLO || []),
      ...(response.data.AIRTEL || []),
      ...(response.data.ETISALAT || []),
    ];

    const eaPlan = allPlans.find(p => p.plan_id == dataplan);
    if (!eaPlan) return res.status(400).json({ success: false, message: "Plan not found on EasyAccess" });

    const eaPrice = parseFloat(eaPlan.amount);

    // 4️⃣ Check user balance against custom price
    if (user.balance < customPrice) {
      return res.status(400).json({ success: false, message: "Insufficient balance", user_balance: user.balance });
    }

    // 5️⃣ Deduct balance
    const balance_before = parseFloat(user.balance);
    const balance_after = balance_before - customPrice;
    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    // 6️⃣ Insert transaction
    await db.query(
      `INSERT INTO transactions 
      (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        client_reference,
        "data",
        customPrice,
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

    // 7️⃣ Send request to EasyAccess with actual EA price
    const params = new URLSearchParams();
    params.append("network", network);
    params.append("mobileno", mobile_no);
    params.append("dataplan", dataplan);
    params.append("client_reference", client_reference);
    params.append("max_amount_payable", eaPrice.toString()); // real EA price
    params.append("webhook_url", "https://YOUR_DEPLOYED_BACKEND_URL/buydata/webhook");

    const eaResponse = await axios.post(`${BASE_URL}/data.php`, params.toString(), {
      headers: { AuthorizationToken: API_TOKEN, "Content-Type": "application/x-www-form-urlencoded" },
    });

    // 8️⃣ Update transaction with api_amount if returned
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
      amount: customPrice,
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
