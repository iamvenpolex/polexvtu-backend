const express = require("express");
const axios = require("axios");
const qs = require("qs");
const db = require("../config/db");

const router = express.Router();

// ✅ EasyAccess API Config
const BASE_URL = "https://easyaccessapi.com.ng/api/data.php";
const AUTH_TOKEN = process.env.EASY_ACCESS_TOKEN; // e.g., "904cc8b30fb06707862323030783481b"

// ✅ Network codes mapping
const NETWORK_CODES = {
  MTN: "01",
  GLO: "02",
  AIRTEL: "03",
  "9MOBILE": "04",
};

// ✅ Normalize network name
const normalizeNetwork = (name) => {
  if (!name) return null;
  name = name.toUpperCase();
  if (["9M", "9MOBILE", "ETISALAT"].includes(name)) return "9MOBILE";
  return NETWORK_CODES[name] ? name : null;
};

// ===================================================
// ✅ FETCH DATA PLANS FROM EASYACCESS AND SAVE TO DB
// ===================================================
router.get("/data-plans", async (req, res) => {
  try {
    const selectedNetwork = normalizeNetwork(req.query.network);
    if (!selectedNetwork) {
      return res.status(400).json({ message: "Invalid or missing network parameter" });
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

    const raw = response.data;
    console.log(`✅ Raw response for ${selectedNetwork}:`, raw);

    let plans = [];
    if (Array.isArray(raw)) plans = raw;
    else if (Array.isArray(raw.data)) plans = raw.data;
    else if (Array.isArray(raw.plans)) plans = raw.plans;
    else if (raw.plans && typeof raw.plans === "object") plans = Object.values(raw.plans);

    if (!plans.length) {
      console.warn(`⚠️ No plans found for ${selectedNetwork}`);
      return res.status(404).json({ message: "No plans found", raw });
    }

    // ✅ Get provider_id for the network
    const [provider] = await db.query(
      "SELECT id FROM providers WHERE name = ? AND service_type = 'data' LIMIT 1",
      [selectedNetwork]
    );

    if (!provider.length) {
      return res.status(404).json({ message: `Provider not found for ${selectedNetwork}` });
    }

    const provider_id = provider[0].id;

    // ✅ Get service_id for data
    const [service] = await db.query("SELECT id FROM services WHERE name = 'Data' LIMIT 1");
    const service_id = service.length ? service[0].id : 1;

    // ✅ Save or update plans
    for (const plan of plans) {
      const planName = plan.plan_name || plan.name || plan.dataplan;
      const planCode = plan.plan_id || plan.id || plan.dataplan_id;
      const price = Number(plan.price) || Number(plan.amount) || 0;

      await db.query(
        `INSERT INTO plans (provider_id, service_id, plan_name, plan_code, cost_price, selling_price, validity, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           cost_price = VALUES(cost_price),
           selling_price = VALUES(selling_price),
           validity = VALUES(validity),
           status = VALUES(status)`,
        [
          provider_id,
          service_id,
          planName,
          planCode,
          price,
          price + 20, // Example markup
          plan.validity || "N/A",
          "active",
        ]
      );
    }

    console.log(`✅ Saved ${plans.length} ${selectedNetwork} plans`);
    res.json({ message: `Saved ${plans.length} ${selectedNetwork} plans`, plans });
  } catch (error) {
    console.error("❌ Error fetching data plans:", error.response?.data || error.message);
    res.status(500).json({
      message: "Failed to fetch data plans",
      error: error.response?.data || error.message,
    });
  }
});

// ===================================================
// ✅ BUY DATA
// ===================================================
router.post("/buy-data", async (req, res) => {
  try {
    const { userId, network, plan_code, mobile_number } = req.body;

    if (!userId || !network || !plan_code || !mobile_number) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const normalizedNetwork = normalizeNetwork(network);
    if (!normalizedNetwork) return res.status(400).json({ message: "Invalid network" });

    const client_reference = `EA${Date.now()}`;
    const payload = qs.stringify({
      network: NETWORK_CODES[normalizedNetwork],
      mobileno: mobile_number,
      dataplan: plan_code,
      client_reference,
    });

    console.log("🚀 Sending EasyAccess buy request:", payload);

    const response = await axios.post(BASE_URL, payload, {
      headers: {
        AuthorizationToken: AUTH_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const raw = response.data;
    console.log("✅ EasyAccess response:", raw);

    if (!raw || raw.status === "error" || raw.success === "false") {
      return res.status(400).json({ message: raw.message || "Purchase failed", raw });
    }

    // ✅ Log successful transaction
    const amount = Number(raw.amount) || 0;
    await db.query(
      `INSERT INTO transactions (user_id, reference, type, amount, status)
       VALUES (?, ?, 'fund', ?, 'success')`,
      [userId, client_reference, amount]
    );

    res.json({
      message: "✅ Data purchase successful",
      reference: client_reference,
      details: raw,
    });
  } catch (error) {
    console.error("❌ Error buying data:", error.response?.data || error.message);
    res.status(500).json({
      message: "Failed to complete data purchase",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
