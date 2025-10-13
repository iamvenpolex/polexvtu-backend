// routes/vtu.js
"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const { protect } = require("../middleware/authMiddleware"); // optional protect if you want to protect plans
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * GET /api/vtu/plans/:product_type
 * Returns EasyAccess plans + custom prices from DB
 */
router.get("/plans/:product_type", async (req, res) => {
  const { product_type } = req.params;

  try {
    // fetch EA plans for the product_type
    const eaRes = await axios.get(
      `${BASE_URL}/get_plans.php?product_type=${encodeURIComponent(product_type)}`,
      { headers: { AuthorizationToken: API_TOKEN }, timeout: 15000 }
    );

    // EasyAccess returns carrier keys (MTN/GLO/AIRTEL/ETISALAT) — pull them all
    const apiPlans = [
      ...(eaRes.data.MTN || []),
      ...(eaRes.data.GLO || []),
      ...(eaRes.data.AIRTEL || []),
      ...(eaRes.data.ETISALAT || []),
    ];

    // fetch custom prices for this product_type from DB
    const [priceRows] = await db.query(
      "SELECT plan_id, plan_name, api_price, last_api_price, custom_price, status FROM custom_data_prices WHERE product_type = ?",
      [product_type]
    );

    const priceMap = {};
    priceRows.forEach((r) => {
      if (r.status === "active") {
        priceMap[String(r.plan_id)] = {
          plan_name: r.plan_name,
          api_price: r.api_price != null ? Number(r.api_price) : undefined,
          last_api_price: r.last_api_price != null ? Number(r.last_api_price) : undefined,
          custom_price: r.custom_price != null ? Number(r.custom_price) : undefined,
        };
      }
    });

    // combine EA plans with any custom price
    const plansWithCustomPrice = apiPlans.map((p) => {
      const key = String(p.plan_id);
      const meta = priceMap[key];
      return {
        plan_id: p.plan_id,
        name: p.name || (meta?.plan_name ?? ""),
        price: Number(p.amount ?? p.price ?? 0), // EA price
        validity: p.validity ?? "",
        custom_price: meta?.custom_price,
        api_price: meta?.api_price ?? undefined,
        last_api_price: meta?.last_api_price ?? undefined,
        raw: p,
      };
    });

    return res.json({
      success: true,
      message: "Plans loaded successfully",
      product_type,
      plans: plansWithCustomPrice,
    });
  } catch (err) {
    console.error("vtu: fetch plans error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ success: false, message: "Error fetching plans", error: err?.response?.data || err?.message });
  }
});

module.exports = router;
