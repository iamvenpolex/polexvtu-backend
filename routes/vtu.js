const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const API_TOKEN = "3b2a7b74bc8bbe0878460122869864c5";
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * GET /plans/:product_type
 * Returns EA price (static) + custom price (editable)
 */
router.get("/plans/:product_type", async (req, res) => {
  const { product_type } = req.params;

  try {
    // Fetch plans from EasyAccess API
    const response = await axios.get(
      `${BASE_URL}/get_plans.php?product_type=${product_type}`,
      {
        headers: {
          AuthorizationToken: API_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    const apiPlans =
      response.data?.MTN ||
      response.data?.GLO ||
      response.data?.AIRTEL ||
      response.data?.["9MOBILE"] ||
      [];

    // Fetch custom prices from DB
    const [priceRows] = await db.query(
      "SELECT plan_id, custom_price, status FROM custom_data_prices WHERE product_type = ?",
      [product_type]
    );

    const priceMap = {};
    priceRows.forEach((p) => {
      if (p.status === "active" && p.custom_price != null) {
        priceMap[p.plan_id] = p.custom_price;
      }
    });

    // Merge static + custom price
    const plansWithCustomPrice = apiPlans.map((p) => ({
      plan_id: p.plan_id,
      name: p.name,
      price: p.price,
      validity: p.validity,
      custom_price: priceMap[p.plan_id] ?? undefined,
    }));

    return res.json({
      success: true,
      message: "Plans loaded successfully",
      product_type,
      plans: plansWithCustomPrice,
    });
  } catch (error) {
    console.error("Fetch plans error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error fetching plans",
      error: error.response?.data || error.message,
    });
  }
});

/**
 * POST /plans/custom-price
 * Save or update only the custom price
 */
router.post("/plans/custom-price", async (req, res) => {
  const { product_type, plan_id, plan_name, custom_price, status } = req.body;

  if (!product_type || !plan_id || !plan_name || custom_price == null) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  try {
    const [existing] = await db.query(
      "SELECT id FROM custom_data_prices WHERE product_type = ? AND plan_id = ?",
      [product_type, plan_id]
    );

    if (existing.length > 0) {
      await db.query(
        "UPDATE custom_data_prices SET custom_price = ?, status = ? WHERE id = ?",
        [custom_price, status || "active", existing[0].id]
      );
    } else {
      await db.query(
        "INSERT INTO custom_data_prices (product_type, plan_id, plan_name, api_price, custom_price, status) VALUES (?, ?, ?, ?, ?, ?)",
        [product_type, plan_id, plan_name, 0, custom_price, status || "active"]
      );
    }

    return res.json({
      success: true,
      message: "Custom price updated successfully",
    });
  } catch (error) {
    console.error("Custom price update error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to update custom price",
      error: error.message,
    });
  }
});

/**
 * POST /plans/custom-price/bulk
 * Save or update multiple custom prices at once
 */
router.post("/plans/custom-price/bulk", async (req, res) => {
  const { product_type, plans } = req.body;

  if (!product_type || !Array.isArray(plans) || plans.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid payload. Provide product_type and plans array.",
    });
  }

  const connection = db;
  try {
    await connection.query("START TRANSACTION");

    for (const plan of plans) {
      const { plan_id, plan_name, custom_price, status } = plan;

      if (!plan_id || custom_price == null) continue;

      const [existing] = await connection.query(
        "SELECT id FROM custom_data_prices WHERE product_type = ? AND plan_id = ?",
        [product_type, plan_id]
      );

      if (existing.length > 0) {
        await connection.query(
          "UPDATE custom_data_prices SET custom_price = ?, status = ? WHERE id = ?",
          [custom_price, status || "active", existing[0].id]
        );
      } else {
        await connection.query(
          "INSERT INTO custom_data_prices (product_type, plan_id, plan_name, api_price, custom_price, status) VALUES (?, ?, ?, ?, ?, ?)",
          [product_type, plan_id, plan_name, 0, custom_price, status || "active"]
        );
      }
    }

    await connection.query("COMMIT");

    return res.json({
      success: true,
      message: "All custom prices updated successfully",
    });
  } catch (error) {
    await connection.query("ROLLBACK");
    console.error("Bulk custom price update error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to update custom prices",
      error: error.message,
    });
  }
});

module.exports = router;
