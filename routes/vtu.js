"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * GET /vtu/plans/:product_type
 * Returns EasyAccess plans + custom prices from DB
 */
router.get("/plans/:product_type", async (req, res) => {
  const { product_type } = req.params;

  try {
    // 1️⃣ Fetch EA plans
    const response = await axios.get(`${BASE_URL}/get_plans.php?product_type=${product_type}`, {
      headers: { AuthorizationToken: API_TOKEN },
    });

    const apiPlans = [
      ...(response.data.MTN || []),
      ...(response.data.GLO || []),
      ...(response.data.AIRTEL || []),
      ...(response.data.ETISALAT || []),
    ];

    // 2️⃣ Fetch custom prices from DB
    const [priceRows] = await db.query(
      "SELECT plan_id, custom_price, status FROM custom_data_prices WHERE product_type = ?",
      [product_type]
    );

    const priceMap = {};
    priceRows.forEach((p) => {
      if (p.status === "active" && p.custom_price != null) {
        priceMap[p.plan_id] = Number(p.custom_price);
      }
    });

    // 3️⃣ Merge plans
    const plansWithCustomPrice = apiPlans.map((p) => ({
      plan_id: p.plan_id,
      name: p.name,
      price: Number(p.amount),
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

module.exports = router;
