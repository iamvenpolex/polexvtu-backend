// vtu.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // ✅ Make sure DB is connected
const router = express.Router();

const API_TOKEN = "3b2a7b74bc8bbe0878460122869864c5"; // replace with your real API token
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * GET /plans/:product_type
 * Fetch plans from EasyAccessAPI and apply admin custom prices.
 * Only plans with custom prices will be returned.
 */
router.get("/plans/:product_type", async (req, res) => {
  const { product_type } = req.params;

  try {
    // Fetch plans from EasyAccessAPI
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
      response.data?.ETISALAT ||
      [];

    // Get admin custom prices from MySQL
    const [priceRows] = await db.query(
      "SELECT plan_id, custom_price, status FROM data_plan_prices WHERE product_type = ?",
      [product_type]
    );

    // Map DB rows for fast lookup
    const priceMap = {};
    priceRows.forEach((p) => {
      if (p.status === "active" && p.custom_price) {
        priceMap[p.plan_id] = p.custom_price;
      }
    });

    // Filter plans that have an active custom price
    const plansWithPrice = apiPlans
      .filter((p) => priceMap[p.plan_id])
      .map((p) => ({
        ...p,
        price: priceMap[p.plan_id],
      }));

    return res.json({
      success: true,
      message: "Plans loaded successfully",
      product_type,
      plans: plansWithPrice,
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
 * Update or insert custom price for a plan (Admin control)
 * Body: { product_type, plan_id, plan_name, custom_price, status }
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
      "SELECT id FROM data_plan_prices WHERE product_type = ? AND plan_id = ?",
      [product_type, plan_id]
    );

    if (existing.length > 0) {
      // Update
      await db.query(
        "UPDATE data_plan_prices SET custom_price = ?, status = ? WHERE id = ?",
        [custom_price, status || "active", existing[0].id]
      );
    } else {
      // Insert
      await db.query(
        "INSERT INTO data_plan_prices (product_type, plan_id, plan_name, api_price, custom_price, status) VALUES (?, ?, ?, ?, ?, ?)",
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

module.exports = router;
