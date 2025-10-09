// routes/plan.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const BASE_URL = "https://easyaccessapi.com/api/v1"; // ✅ EasyAccess base URL
const AUTH_TOKEN = "your_real_token_here"; // ✅ replace this with your actual token

// ✅ Fetch Data Plans from EasyAccess
router.get("/data", async (req, res) => {
  try {
    console.log("Fetching EasyAccess data plans...");

    const response = await axios.get(`${BASE_URL}/data`, {
      headers: { Authorization: `Token ${AUTH_TOKEN}` },
    });

    console.log("✅ EasyAccess response received.");

    // EasyAccess returns an object; ensure it's an array
    const plans = response.data?.data || response.data || [];

    if (!Array.isArray(plans)) {
      console.error("❌ Unexpected data format from EasyAccess:", response.data);
      return res.status(500).json({ message: "Unexpected response format" });
    }

    // ✅ Save each plan to your DB
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
    console.error("❌ Error fetching plans:", error.response?.data || error.message);

    res.status(500).json({
      message: "Failed to fetch data plans",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
