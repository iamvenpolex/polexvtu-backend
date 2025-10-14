const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN; 
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * GET /cabletv/plans/:company_code
 * Returns EA price + custom price (if set by admin)
 * Also populates database with new plans automatically
 */
router.get("/plans/:company_code", async (req, res) => {
  const { company_code } = req.params;

  try {
    // 1️⃣ Fetch EA plans
    const response = await axios.get(`${BASE_URL}/get_plans.php?product_type=cabletv`, {
      headers: { AuthorizationToken: API_TOKEN },
    });

    const apiPlans = response.data?.[company_code] || [];

    if (apiPlans.length === 0) {
      return res.json({ success: true, plans: [], company_code });
    }

    // 2️⃣ Fetch custom prices from DB
    const [dbPrices] = await db.query(
      "SELECT package_code, custom_price, status FROM custom_cabletv_prices WHERE company_code = ?",
      [company_code]
    );

    const priceMap = {};
    dbPrices.forEach(p => {
      if (p.status === "active" && p.custom_price != null) {
        priceMap[p.package_code] = p.custom_price;
      }
    });

    // 3️⃣ Populate new plans into DB if they don't exist
    for (const plan of apiPlans) {
      const exists = dbPrices.find(p => p.package_code === plan.plan_id);
      if (!exists) {
        await db.query(
          `INSERT INTO custom_cabletv_prices
          (company_code, package_code, package_name, ea_price, custom_price, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
          [company_code, plan.plan_id, plan.name, plan.price, plan.price]
        );
      }
    }

    // 4️⃣ Merge EA price with custom price (do not overwrite admin-set custom_price)
    const mergedPlans = apiPlans.map(p => ({
      package_code: p.plan_id,
      package_name: p.name,
      ea_price: p.price,
      custom_price: priceMap[p.plan_id] ?? p.price,
    })).filter(p => p.custom_price > 0);

    res.json({ success: true, plans: mergedPlans, company_code });

  } catch (error) {
    console.error("Fetch cabletv plans error:", error.message);
    res.status(500).json({ success: false, message: "Failed to load plans", error: error.message });
  }
});

module.exports = router;
