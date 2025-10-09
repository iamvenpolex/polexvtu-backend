// routes/plan.js
const express = require("express");
const axios = require("axios");
const qs = require("qs");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN; // keep token in .env
const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";

// Network codes
const NETWORK_CODES = {
  MTN: "01",
  GLO: "02",
  AIRTEL: "03",
  "9MOBILE": "04",
};

// ✅ Fetch Data Plans for all networks
router.get("/data", async (req, res) => {
  try {
    let allPlans = [];

    for (const [network, code] of Object.entries(NETWORK_CODES)) {
      console.log(`📡 Fetching ${network} plans...`);

      const response = await axios.post(
        BASE_URL,
        qs.stringify({ network: code }), // send network code
        {
          headers: {
            AuthorizationToken: AUTH_TOKEN,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const plans = response.data?.data || response.data || [];
      if (!Array.isArray(plans)) {
        console.error(`❌ Unexpected format for ${network}:`, response.data);
        continue;
      }

      // Save network info in each plan
      const normalizedPlans = plans.map((plan) => ({
        ...plan,
        network,
      }));

      allPlans.push(...normalizedPlans);

      // ✅ Save in DB
      for (const plan of normalizedPlans) {
        await db.query(
          `INSERT INTO plans (plan_id, network, plan_name, price)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE plan_name = VALUES(plan_name), price = VALUES(price)`,
          [plan.plan_id, plan.network, plan.name || plan.plan_name, plan.price]
        );
      }

      console.log(`✅ ${network} plans fetched: ${normalizedPlans.length}`);
    }

    if (!allPlans.length) {
      return res.status(500).json({ message: "No data plans found" });
    }

    res.json(allPlans);
  } catch (error) {
    console.error("❌ Error fetching data plans:", error.response?.data || error.message);
    res.status(500).json({ message: "Failed to fetch data plans", error: error.message });
  }
});

// DEBUG: Fetch raw response for a single network
router.get("/data-debug/:network", async (req, res) => {
  try {
    const network = req.params.network.toUpperCase();
    if (!NETWORK_CODES[network]) {
      return res.status(400).json({ message: "Invalid network" });
    }

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
    console.error("❌ Error fetching plans (DEBUG):", error.response?.data || error.message);
    res.status(500).json({ message: "Failed to fetch data plans", error: error.message });
  }
});

module.exports = router;
