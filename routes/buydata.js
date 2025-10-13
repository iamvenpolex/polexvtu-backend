"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const BASE_URL = "https://easyaccessapi.com.ng/api";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

// Utility: fetch EA price for a given plan_id and product_type
async function fetchEaPrice(product_type, plan_id) {
  try {
    const res = await axios.get(`${BASE_URL}/get_plans.php?product_type=${product_type}`, {
      headers: {
        AuthorizationToken: API_TOKEN,
        "Content-Type": "application/json",
      },
    });

    const allPlans = res.data?.MTN || res.data?.GLO || res.data?.AIRTEL || res.data?.ETISALAT || [];
    const plan = allPlans.find((p) => String(p.plan_id) === String(plan_id));

    if (!plan) throw new Error("Plan not found in EA API");
    return parseFloat(plan.price);
  } catch (error) {
    console.error("Failed to fetch EA price:", error.message);
    throw new Error("Unable to fetch EA price");
  }
}

router.post("/", async (req, res) => {
  const { user_id, network, mobile_no, dataplan, product_type, client_reference } = req.body;

  // Basic validations
  if (!user_id || !network || !mobile_no || !dataplan || !client_reference || !product_type) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }
  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({ success: false, message: "Mobile number must be 11 digits" });
  }

  try {
    // Fetch user wallet
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    // Fetch plan info
    const [plans] = await db.query(
      "SELECT plan_id, plan_name, custom_price FROM custom_data_prices WHERE plan_id = ? AND status='active'",
      [dataplan]
    );
    if (!plans.length) return res.status(400).json({ success: false, message: "Plan not available" });
    const plan = plans[0];

    // EA price (must use this for max_amount_payable)
    const eaPrice = await fetchEaPrice(product_type, dataplan);

    // Wallet deduction uses custom price (your margin)
    const priceToDeduct = parseFloat(plan.custom_price);
    if (user.balance < priceToDeduct) return res.status(400).json({ success: false, message: "Insufficient balance" });

    // Deduct wallet
    const balance_before = parseFloat(user.balance);
    const balance_after = balance_before - priceToDeduct;
    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    // Insert transaction
    await db.query(
      `INSERT INTO transactions 
      (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        client_reference,
        "data",
        priceToDeduct,
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

    // Send request to EasyAccess (use EA price, not custom)
    const params = new URLSearchParams();
    params.append("network", network);
    params.append("mobileno", mobile_no);
    params.append("dataplan", dataplan);
    params.append("client_reference", client_reference);
    params.append("max_amount_payable", eaPrice.toString()); // <-- EA expects this
    params.append("webhook_url", "https://YOUR_DEPLOYED_BACKEND_URL/buydata/webhook");

    console.log(`➡️ Sending request to EasyAccess [${client_reference}]:`, params.toString());
    const response = await axios.post(`${BASE_URL}/data.php`, params.toString(), {
      headers: {
        AuthorizationToken: API_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    console.log(`✅ EasyAccess response [${client_reference}]:`, response.data);

    // Update API amount if returned
    if (response.data?.amount) {
      await db.query("UPDATE transactions SET api_amount = ? WHERE reference = ?", [
        response.data.amount,
        client_reference,
      ]);
    }

    return res.json({
      success: true,
      message: "Purchase initiated. Awaiting EasyAccess confirmation via webhook.",
      reference: client_reference,
      user_id: user.id,
      amount: priceToDeduct,
      network,
      phone: mobile_no,
      plan: plan.plan_name,
      status: "pending",
      ea_price: eaPrice,
      api_response: response.data,
    });
  } catch (error) {
    console.error(`❌ Buy data error [${client_reference}]:`, error.message);
    return res.status(500).json({
      success: false,
      message: "Error purchasing data",
      error: error.message,
    });
  }
});

module.exports = router;
