"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const BASE_URL = "https://easyaccessapi.com.ng/api";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN; // EasyAccess token

// Utility: Get EA price for a given plan_id and product_type
async function fetchEaPrice(product_type, plan_id) {
  try {
    const res = await axios.get(`${BASE_URL}/get_plans.php?product_type=${product_type}`, {
      headers: {
        AuthorizationToken: API_TOKEN,
        "Content-Type": "application/json",
      },
    });

    // EA returns plans under MTN, GLO, etc.
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

  if (!user_id || !network || !mobile_no || !dataplan || !client_reference || !product_type) {
    console.log("❌ Missing required fields:", req.body);
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  if (!/^\d{11}$/.test(mobile_no)) {
    console.log("❌ Invalid mobile number:", mobile_no);
    return res.status(400).json({ success: false, message: "Mobile number must be 11 digits" });
  }

  try {
    // Fetch user
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    // Fetch plan from DB (to get custom_price and plan_name)
    const [plans] = await db.query(
      "SELECT plan_id, plan_name, custom_price FROM custom_data_prices WHERE plan_id = ? AND status='active'",
      [dataplan]
    );
    if (!plans.length) return res.status(400).json({ success: false, message: "Plan not available" });
    const plan = plans[0];

    // Determine EA price dynamically
    const eaPrice = await fetchEaPrice(product_type, dataplan);

    // Use custom price for wallet deduction
    const priceToDeduct = parseFloat(plan.custom_price);

    if (user.balance < priceToDeduct) {
      console.log("❌ Insufficient balance", { user_balance: user.balance, priceToDeduct });
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // Deduct balance
    const balance_before = parseFloat(user.balance);
    const balance_after = balance_before - priceToDeduct;
    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    // Insert transaction
    const transactionData = {
      user_id: user.id,
      reference: client_reference,
      type: "data",
      amount: priceToDeduct,
      api_amount: 0,
      status: "pending",
      network,
      plan: plan.plan_name,
      phone: mobile_no,
      via: "wallet",
      description: `Data purchase of ${plan.plan_name} via wallet`,
      balance_before,
      balance_after,
    };

    await db.query(
      `INSERT INTO transactions 
      (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionData.user_id,
        transactionData.reference,
        transactionData.type,
        transactionData.amount,
        transactionData.api_amount,
        transactionData.status,
        transactionData.network,
        transactionData.plan,
        transactionData.phone,
        transactionData.via,
        transactionData.description,
        transactionData.balance_before,
        transactionData.balance_after,
      ]
    );

    // Prepare EA request
    const params = new URLSearchParams();
    params.append("network", network);
    params.append("mobileno", mobile_no);
    params.append("dataplan", dataplan);
    params.append("client_reference", client_reference);
    params.append("max_amount_payable", eaPrice.toString()); // <-- EA price dynamically
    params.append("webhook_url", "https://YOUR_DEPLOYED_BACKEND_URL/buydata/webhook");

    console.log(`➡️ Sending request to EasyAccess [${client_reference}]:`, params.toString());

    const response = await axios.post(`${BASE_URL}/data.php`, params.toString(), {
      headers: {
        AuthorizationToken: API_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    console.log(`✅ EasyAccess response [${client_reference}]:`, response.data);

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
