// routes/plan.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

// ✅ Use environment variable for your EasyAccess token
const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api"; // ✅ Correct base URL (old API)

router.get("/data", async (req, res) => {
  try {
    console.log("📡 Fetching EasyAccess data plans...");

    const response = await axios.post(
      `${BASE_URL}/data.php`,
      {}, // No body needed for plan list
      {
        headers: {
          AuthorizationToken: AUTH_TOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("✅ EasyAccess response received:", response.data);

    const plans = response.data || [];

    if (!Array.isArray(plans)) {
      console.error("❌ Unexpected data format from EasyAccess:", response.data);
      return res
        .status(500)
        .json({ message: "Unexpected response format from EasyAccess" });
    }

    // ✅ Save or update each plan in DB
    for (const plan of plans) {
      await db.query(
        `INSERT INTO plans (plan_id, network, plan_name, price)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           plan_name = VALUES(plan_name),
           price = VALUES(price)`,
        [plan.plan_id, plan.network, plan.plan_name, plan.price]
      );
    }

    res.status(200).json(plans);
  } catch (error) {
    console.error(
      "❌ Error fetching plans:",
      error.response?.data || error.message
    );
    res.status(500).json({
      message: "Failed to fetch data plans",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
