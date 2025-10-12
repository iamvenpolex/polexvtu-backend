"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";
const API_TOKEN = process.env.EASY_ACCESS_TOKEN; // Use ENV for security

/**
 * POST /buydata
 * Body: { user_id, network, mobile_no, dataplan, client_reference }
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
    // Fetch user
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    // Fetch plan price
    const [plans] = await db.query(
      "SELECT plan_id, plan_name, custom_price FROM custom_data_prices WHERE plan_id = ? AND status='active'",
      [dataplan]
    );
    if (!plans.length) return res.status(400).json({ success: false, message: "Plan not available" });
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

    // Deduct balance and store transaction
    const balance_before = parseFloat(user.balance);
    const balance_after = balance_before - price;

    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    const transactionData = {
      user_id: user.id,
      reference: client_reference,
      type: "data",
      amount: price,
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

    // Call EasyAccess API using form-urlencoded
    const params = new URLSearchParams();
    params.append("network", network);
    params.append("mobileno", mobile_no);
    params.append("dataplan", dataplan);
    params.append("client_reference", client_reference);
    params.append("max_amount_payable", price.toString());
    params.append("webhook_url", "https://polexvtu-backend-production.up.railway.app/buydata/webhook");

    const response = await axios.post(BASE_URL, params.toString(), {
      headers: {
        "AuthorizationToken": API_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    console.log("EasyAccess API response:", response.data);

    // Update api_amount if returned
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
      amount: price,
      network,
      phone: mobile_no,
      plan: plan.plan_name,
      status: "pending",
      api_response: response.data,
    });

  } catch (error) {
    console.error("Buy data error:", error);

    // Optional: refund if needed
    // await db.query("UPDATE users SET balance = balance + ? WHERE id = ?", [price, user_id]);

    return res.status(500).json({
      success: false,
      message: "Error purchasing data",
      error: error.message,
    });
  }
});

/**
 * POST /buydata/webhook
 * EasyAccess sends transaction updates here
 */
router.post("/webhook", async (req, res) => {
  const payload = req.body;

  try {
    const { client_reference, status, amount: apiAmount } = payload;
    if (!client_reference) return res.status(400).json({ success: false, message: "No client_reference" });

    const [transactions] = await db.query("SELECT * FROM transactions WHERE reference = ?", [client_reference]);
    if (!transactions.length) return res.status(404).json({ success: false, message: "Transaction not found" });

    const transaction = transactions[0];

    console.log(`Webhook received for reference: ${client_reference}`, payload);

    if (apiAmount) {
      await db.query("UPDATE transactions SET api_amount = ? WHERE id = ?", [apiAmount, transaction.id]);
    }

    if (status === "success") {
      await db.query("UPDATE transactions SET status = 'success' WHERE id = ?", [transaction.id]);
      console.log(`Transaction ${client_reference} marked SUCCESS`);
    } else if (status === "failed") {
      await db.query("UPDATE transactions SET status = 'failed' WHERE id = ?", [transaction.id]);
      await db.query("UPDATE users SET balance = balance + ? WHERE id = ?", [transaction.amount, transaction.user_id]);
      console.log(`Transaction ${client_reference} FAILED and refunded`);
    }

    return res.json({ success: true, message: "Webhook processed" });

  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({ success: false, message: "Error processing webhook", error: error.message });
  }
});

module.exports = router;
