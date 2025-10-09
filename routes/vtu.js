// routes/vtu.js
const express = require("express");
const axios = require("axios");
const qs = require("qs");
const db = require("../config/db");
const router = express.Router();

const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";

// ===============================
// ✅ FETCH DATA PLANS
// ===============================
const NETWORK_CODES = {
  MTN: "01",
  GLO: "02",
  AIRTEL: "03",
  "9MOBILE": "04",
};

router.get("/data-plans", async (req, res) => {
  try {
    console.log("📡 Fetching EasyAccess data plans...");

    let allPlans = [];

    for (const [network, code] of Object.entries(NETWORK_CODES)) {
      console.log(`📡 Fetching ${network} plans...`);

      const response = await axios.post(
        BASE_URL,
        qs.stringify({ network: code }),
        {
          headers: {
            AuthorizationToken: AUTH_TOKEN,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      let plans = [];
      if (Array.isArray(response.data)) {
        plans = response.data;
      } else if (Array.isArray(response.data?.data)) {
        plans = response.data.data;
      } else if (Array.isArray(response.data?.plans)) {
        plans = response.data.plans;
      } else {
        console.warn(`❌ Unexpected format for ${network}:`, response.data);
        continue;
      }

      if (!plans.length) {
        console.warn(`⚠️ No plans returned for ${network}`);
        continue;
      }

      const normalizedPlans = plans.map((plan) => ({
        ...plan,
        network,
      }));

      allPlans.push(...normalizedPlans);

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
    res.status(500).json({
      message: "Failed to fetch data plans",
      error: error.message,
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
    const [userRows] = await db.query("SELECT balance FROM users WHERE id = ?", [userId]);
    if (userRows.length === 0) return res.status(404).json({ message: "User not found" });

    const balance = userRows[0].balance;

    const [planRows] = await db.query("SELECT price, plan_name FROM plans WHERE plan_id = ?", [plan_id]);
    if (planRows.length === 0) return res.status(404).json({ message: "Plan not found" });

    const plan = planRows[0];

    if (balance < plan.price) {
      return res.status(400).json({ message: "Insufficient wallet balance" });
    }

    const data = new URLSearchParams({
      network,
      mobileno: mobile_number,
      dataplan: plan_id,
      client_reference: `tranx${Date.now()}`,
    });

    const response = await axios.post(BASE_URL, data, {
      headers: {
        AuthorizationToken: AUTH_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    console.log("📨 EasyAccess Purchase Response:", response.data);

    if (response.data.status !== "successful") {
      return res.status(400).json({
        message: "Purchase failed",
        data: response.data,
      });
    }

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
