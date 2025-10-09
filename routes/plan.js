// routes/plan.js
const express = require("express");
const axios = require("axios");
const qs = require("qs");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN; // keep token in .env
const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";

// ✅ Fetch Data Plans
router.get("/data", async (req, res) => {
  try {
    console.log("📡 Fetching EasyAccess data plans...");

    const response = await axios.post(
      BASE_URL,
      qs.stringify({}),
      {
        headers: {
          AuthorizationToken: AUTH_TOKEN,
          "cache-control": "no-cache",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("✅ EasyAccess response received:", response.data);

    // ✅ Normalize plans into an array
    let plans = [];
    if (response.data && typeof response.data === "object") {
      // If response is an object of plans, convert to array
      plans = Object.values(response.data);
    } else if (Array.isArray(response.data)) {
      plans = response.data;
    }

    if (!plans.length) {
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

    // ✅ Always return an array to frontend
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
