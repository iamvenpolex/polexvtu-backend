const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db"); // ✅ postgres.js client

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

// ✅ Helper: Insert plan if missing (Postgres version)
const insertPlanIfMissing = async (companyCode, plan) => {
  await db`
    INSERT INTO custom_cabletv_prices (
      company_code, package_code, package_name, ea_price, status
    )
    VALUES (
      ${companyCode}, ${plan.plan_id}, ${plan.name}, ${plan.price}, 'active'
    )
    ON CONFLICT (company_code, package_code) DO NOTHING
  `;
};

// ✅ GET /api/cabletv/:company
router.get("/:company", async (req, res) => {
  try {
    const { company } = req.params;

    // Fetch EA plans
    const response = await axios.get(
      `${BASE_URL}/get_plans.php?product_type=${company}`,
      {
        headers: {
          AuthorizationToken: EASY_ACCESS_TOKEN,
          "cache-control": "no-cache",
        },
      }
    );

    const eaPlans = response.data[company.toUpperCase()] || [];

    // ✅ Insert missing plans automatically
    for (let plan of eaPlans) {
      await insertPlanIfMissing(company, plan);
    }

    // ✅ Fetch custom prices from DB
    const rows = await db`
      SELECT package_code, custom_price 
      FROM custom_cabletv_prices 
      WHERE company_code = ${company}
    `;

    // ✅ Merge EA prices + custom prices
    const plansWithCustom = eaPlans.map((plan) => {
      const custom = rows.find((r) => r.package_code === plan.plan_id);

      return {
        ...plan,
        customPrice: custom?.custom_price ?? plan.price,
      };
    });

    res.json({ success: true, plans: plansWithCustom });
  } catch (error) {
    console.error("❌ Cable TV Fetch Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch plans",
    });
  }
});

// ✅ POST /api/cabletv/admin/setCustomPrice
router.post("/admin/setCustomPrice", async (req, res) => {
  try {
    const { company_code, package_code, custom_price } = req.body;

    if (!company_code || !package_code || !custom_price) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    // ✅ Update custom price
    await db`
      UPDATE custom_cabletv_prices
      SET custom_price = ${custom_price}, updated_at = NOW()
      WHERE company_code = ${company_code} 
      AND package_code = ${package_code}
    `;

    res.json({
      success: true,
      message: "Custom price updated successfully",
    });
  } catch (error) {
    console.error("❌ Update Price Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to update price",
    });
  }
});

module.exports = router;
