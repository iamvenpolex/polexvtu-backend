// routes/vtu.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN; // ✅ Store this securely in .env
const BASE_URL = "https://easyaccessapi.com.ng/api";

// ===============================
// ✅ FETCH DATA PLANS
// ===============================
router.get("/data-plans", async (req, res) => {
  try {
    console.log("📡 Fetching EasyAccess data plans...");

    const response = await axios.get(`${BASE_URL}/data.php`, {
      headers: {
        AuthorizationToken: AUTH_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    console.log("✅ EasyAccess response received:", response.data);

    // ✅ Verify format
    if (!response.data || typeof response.data !== "object") {
      console.error("❌ No plans found or unexpected format:", response.data);
      return res.status(404).json({
        message: "No data plans found or unexpected format",
        response: response.data,
      });
    }

    // ✅ Send the plans directly
    res.json(response.data);
  } catch (error) {
    console.error("❌ Error fetching plans:", error.response?.data || error.message);
    res.status(500).json({
      message: "Failed to fetch data plans",
      error: error.response?.data || error.message,
    });
  }
});

// ===============================
// ✅ BUY DATA
// ===============================
router.post("/buy-data", async (req, res) => {
  const { userId, network, mobile_number, plan_id } = req.body;

  if (!userId || !network || !mobile_number || !plan_id) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    // ✅ Fetch user wallet balance
    const [userRows] = await db.query("SELECT balance FROM users WHERE id = ?", [userId]);
    if (userRows.length === 0) return res.status(404).json({ message: "User not found" });

    const balance = userRows[0].balance;

    // ✅ Get plan price
    const [planRows] = await db.query("SELECT price, plan_name FROM plans WHERE plan_id = ?", [plan_id]);
    if (planRows.length === 0) return res.status(404).json({ message: "Plan not found" });

    const plan = planRows[0];

    // ✅ Check balance
    if (balance < plan.price) {
      return res.status(400).json({ message: "Insufficient wallet balance" });
    }

    // ✅ Prepare request to EasyAccess
    const data = new URLSearchParams({
      network,
      mobileno: mobile_number,
      dataplan: plan_id,
      client_reference: `tranx${Date.now()}`,
    });

    const response = await axios.post(`${BASE_URL}/data.php`, data, {
      headers: {
        AuthorizationToken: AUTH_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    console.log("📨 EasyAccess Purchase Response:", response.data);

    // ✅ Validate API response
    if (response.data.status !== "successful") {
      return res.status(400).json({
        message: "Purchase failed",
        data: response.data,
      });
    }

    // ✅ Deduct balance and record transaction
    await db.query("UPDATE users SET balance = balance - ? WHERE id = ?", [plan.price, userId]);
    await db.query(
      "INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, ?, ?, ?, ?)",
      [userId, "data purchase", plan.price, `${plan.plan_name} - ${mobile_number}`, "successful"]
    );

    res.status(200).json({
      message: "Data purchased successfully",
      transaction: response.data,
    });
  } catch (error) {
    console.error("❌ Error buying data:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error processing transaction",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
