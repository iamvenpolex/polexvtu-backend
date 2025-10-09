// routes/plan.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

// ✅ Fetch data plans (directly from EasyAccess)
router.get("/data", async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/data/`, {
      headers: { Authorization: `Token ${AUTH_TOKEN}` },
    });

    const plans = response.data || [];

    // Optional: save or update to your database
    for (const plan of plans) {
      await db.query(
        `INSERT INTO plans (plan_id, network, plan_name, price) 
         VALUES (?, ?, ?, ?) 
         ON DUPLICATE KEY UPDATE plan_name = VALUES(plan_name), price = VALUES(price)`,
        [plan.plan_id, plan.network, plan.plan_name, plan.price]
      );
    }

    res.status(200).json(plans);
  } catch (error) {
    console.error("Error fetching plans:", error.message);
    res.status(500).json({ message: "Failed to fetch data plans", error: error.message });
  }
});

module.exports = router;
