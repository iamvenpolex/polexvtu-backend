const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN; 
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * GET /cabletv/plans/:company_code
 * Returns EA price + custom price (if set by admin)
 */
router.get("/plans/:company_code", async (req, res) => {
  const { company_code } = req.params;

  try {
    // 1️⃣ Fetch EA plans
    const response = await axios.get(`${BASE_URL}/get_plans.php?product_type=cabletv`, {
      headers: { AuthorizationToken: API_TOKEN },
    });

    const apiPlans = response.data?.[company_code] || [];

    // 2️⃣ Fetch custom prices
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

    // 3️⃣ Merge EA price with custom price
    const mergedPlans = apiPlans
      .map(p => ({
        package_code: p.plan_id,
        package_name: p.name,
        ea_price: p.price,
        custom_price: priceMap[p.plan_id] ?? p.price,
      }))
      .filter(p => p.custom_price > 0); // only show active/customized plans

    res.json({ success: true, plans: mergedPlans, company_code });
  } catch (error) {
    console.error("Fetch cabletv plans error:", error.message);
    res.status(500).json({ success: false, message: "Failed to load plans", error: error.message });
  }
});

module.exports = router;
