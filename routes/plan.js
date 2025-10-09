// routes/plan.js
const express = require("express");
const axios = require("axios");
const qs = require("qs");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";

// ✅ Fetch Data Plans
router.get("/data", async (req, res) => {
  try {
    console.log("📡 Fetching EasyAccess data plans...");

    const config = {
      method: "post",
      url: BASE_URL,
      headers: {
        AuthorizationToken: AUTH_TOKEN,
        "cache-control": "no-cache",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: qs.stringify({}),
    };

    const response = await axios(config);

    console.log("✅ EasyAccess response received.");

    // ✅ Extract plans safely
    const plans =
      response.data?.data && Array.isArray(response.data.data)
        ? response.data.data
        : Array.isArray(response.data)
        ? response.data
        : [];

    if (plans.length === 0) {
      console.error("❌ No plans found or unexpected data format:", response.data);
      return res.status(500).json({ message: "No data plans found" });
    }

    // ✅ Save plans in DB
    for (const plan of plans) {
      await db.query(
        `INSERT INTO plans (plan_id, network, plan_name, price)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE plan_name = VALUES(plan_name), price = VALUES(price)`,
        [plan.plan_id, plan.network, plan.plan_name, plan.price]
      );
    }

    // ✅ Always return a clean array
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
