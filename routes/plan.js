// routes/plan.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

router.get("/data", async (req, res) => {
  try {
    console.log("📡 Fetching EasyAccess data plans...");

    const response = await axios.post(
      `${BASE_URL}/data.php`,
      {},
      {
        headers: {
          AuthorizationToken: AUTH_TOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    // 👇 This will show us what EasyAccess actually returns
    console.log("✅ EasyAccess response received (raw):", response.data);

    // Send the raw response back to your browser for inspection
    return res.status(200).json({
      message: "Raw EasyAccess response for debugging",
      data: response.data,
    });
  } catch (error) {
    console.error("❌ Error fetching plans:", error.response?.data || error.message);
    res.status(500).json({
      message: "Failed to fetch data plans",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
