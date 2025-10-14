// routes/cabletv.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // mysql2/promise pool (or connection)
const router = express.Router();

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN; // Your EasyAccess token
const BASE_URL = "https://easyaccessapi.com.ng/api";

// Helper: Insert or update plan into DB (avoid duplicates)
const insertOrUpdatePlan = async (companyCode, plan) => {
  // Use ON DUPLICATE KEY UPDATE to avoid duplicates (requires unique key on company_code+package_code)
  await db.query(
    `INSERT INTO custom_cabletv_prices (company_code, package_code, package_name, ea_price, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', NOW(), NOW())
     ON DUPLICATE KEY UPDATE package_name = VALUES(package_name), ea_price = VALUES(ea_price), updated_at = NOW()`,
    [companyCode, plan.plan_id, plan.name, plan.price]
  );
};

// GET /api/cabletv/:company
router.get("/:company", async (req, res) => {
  try {
    let { company } = req.params; // accept 'dstv','gotv','startimes','showmax'
    if (!company) return res.status(400).json({ success: false, message: "Missing company" });

    // Query EasyAccess for plans (EasyAccess product_type for TV appears to accept names like dstv,gоtv,startimes,showmax)
    console.log(`➡️ Fetching plans from EasyAccess for product_type=${company}`);
    const response = await axios.get(`${BASE_URL}/get_plans.php?product_type=${company}`, {
      headers: { AuthorizationToken: EASY_ACCESS_TOKEN, "cache-control": "no-cache" },
      timeout: 30_000,
    });

    const eaPlans = response.data?.[company.toUpperCase()] || [];

    // Insert or update all plans into DB
    for (let plan of eaPlans) {
      await insertOrUpdatePlan(company, plan);
    }

    // Fetch custom prices from DB and merge
    const [rows] = await db.query("SELECT package_code, custom_price FROM custom_cabletv_prices WHERE company_code = ?", [company]);

    const plansWithCustom = eaPlans.map((plan) => {
      const custom = rows.find((r) => String(r.package_code) === String(plan.plan_id));
      return {
        plan_id: plan.plan_id,
        name: plan.name,
        price: Number(plan.price),
        validity: plan.validity || "",
        customPrice: custom ? Number(custom.custom_price) : Number(plan.price),
      };
    });

    return res.json({ success: true, plans: plansWithCustom });
  } catch (error) {
    console.error("❌ Failed to fetch plans:", error.response?.data || error.message);
    return res.status(500).json({ success: false, message: "Failed to fetch plans" });
  }
});

// POST /api/cabletv/admin/setCustomPrice
router.post("/admin/setCustomPrice", async (req, res) => {
  try {
    const { company_code, package_code, custom_price } = req.body;
    if (!company_code || !package_code || custom_price == null) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    await db.query(
      `UPDATE custom_cabletv_prices
       SET custom_price = ?, updated_at = NOW()
       WHERE company_code = ? AND package_code = ?`,
      [custom_price, company_code, package_code]
    );

    return res.json({ success: true, message: "Custom price updated successfully" });
  } catch (error) {
    console.error("❌ Failed to update custom price:", error);
    return res.status(500).json({ success: false, message: "Failed to update price" });
  }
});

module.exports = router;
