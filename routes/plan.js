// routes/plan.js
const express = require("express");
const axios = require("axios");
const qs = require("qs");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN; // keep token in .env
const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";

// ✅ Network codes mapping
const NETWORK_CODES = {
  MTN: "01",
  GLO: "02",
  AIRTEL: "03",
  "9MOBILE": "04",
};

// ✅ Normalize network input (to handle things like 9M or 9mobile)
const normalizeNetwork = (input) => {
  if (!input) return null;
  input = input.toUpperCase();
  if (input === "9M" || input === "9MOBILE") return "9MOBILE";
  return NETWORK_CODES[input] ? input : null;
};

// ===================================================
// ✅ FETCH DATA PLANS (supports ?network= query)
// ===================================================
router.get("/data", async (req, res) => {
  try {
    const selectedNetwork = normalizeNetwork(req.query.network);

    if (!selectedNetwork) {
      return res
        .status(400)
        .json({ message: "Invalid or missing network parameter" });
    }

    console.log(`📡 Fetching ${selectedNetwork} plans from EasyAccess...`);

    const response = await axios.post(
      BASE_URL,
      qs.stringify({ network: NETWORK_CODES[selectedNetwork] }),
      {
        headers: {
          AuthorizationToken: AUTH_TOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log(`✅ Raw response for ${selectedNetwork}:`, response.data);

    // ✅ Handle different EasyAccess API formats
    let plans = [];
    if (Array.isArray(response.data)) {
      plans = response.data;
    } else if (Array.isArray(response.data?.data)) {
      plans = response.data.data;
    } else if (Array.isArray(response.data?.plans)) {
      plans = response.data.plans;
    } else {
      console.warn(`❌ Unexpected format for ${selectedNetwork}:`, response.data);
      return res
        .status(500)
        .json({ message: "Unexpected API response format", raw: response.data });
    }

    if (!plans.length) {
      console.warn(`⚠️ No plans returned for ${selectedNetwork}`);
      return res.status(404).json({ message: "No data plans found" });
    }

    // ✅ Normalize data
    const normalizedPlans = plans.map((plan) => ({
      plan_id: plan.plan_id,
      plan_name: plan.name || plan.plan_name,
      price: Number(plan.price),
      network: selectedNetwork,
    }));

    // ✅ Save or update in DB
    for (const plan of normalizedPlans) {
      await db.query(
        `INSERT INTO plans (plan_id, network, plan_name, price)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           plan_name = VALUES(plan_name),
           price = VALUES(price)`,
        [plan.plan_id, plan.network, plan.plan_name, plan.price]
      );
    }

    console.log(`✅ ${selectedNetwork} plans saved: ${normalizedPlans.length}`);
    res.json(normalizedPlans);
  } catch (error) {
    console.error(
      "❌ Error fetching data plans:",
      error.response?.data || error.message
    );
    res.status(500).json({
      message: "Failed to fetch data plans",
      error: error.response?.data || error.message,
    });
  }
});

// ===================================================
// ✅ DEBUG: Fetch raw response for a single network
// ===================================================
router.get("/data-debug/:network", async (req, res) => {
  try {
    const network = normalizeNetwork(req.params.network);
    if (!network) {
      return res.status(400).json({ message: "Invalid network" });
    }

    console.log(`🔍 Debugging ${network} raw response...`);

    const response = await axios.post(
      BASE_URL,
      qs.stringify({ network: NETWORK_CODES[network] }),
      {
        headers: {
          AuthorizationToken: AUTH_TOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log(`✅ EasyAccess RAW response for ${network}:`, response.data);
    res.json({ raw: response.data });
  } catch (error) {
    console.error(
      "❌ Error fetching plans (DEBUG):",
      error.response?.data || error.message
    );
    res.status(500).json({
      message: "Failed to fetch data plans",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
