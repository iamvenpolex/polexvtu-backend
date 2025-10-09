// routes/vtu.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN; // ✅ keep token in .env
const BASE_URL = "https://easyaccessapi.com.ng/api";

// ✅ Buy Data
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

    // ✅ Send API request to EasyAccess
    const response = await axios.post(
      `${BASE_URL}/data/`,
      {
        network,
        mobile_number,
        plan: plan_id,
        Ported_number: true,
      },
      {
        headers: { Authorization: `Token ${AUTH_TOKEN}` },
      }
    );

    // ✅ Check API response
    if (response.data.status !== "successful") {
      return res.status(400).json({ message: "Purchase failed", data: response.data });
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
    console.error("Error buying data:", error.message);
    res.status(500).json({ message: "Error processing transaction", error: error.message });
  }
});

module.exports = router;
