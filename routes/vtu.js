// routes/vtu.js
"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * GET /api/vtu/plans/:product_type
 *
 * Returns EasyAccess plans merged with custom_data_prices for the given product_type.
 * product_type is one of your product keys: mtn_sme, mtn_cg_lite, mtn_cg, ...
 */
router.get("/plans/:product_type", async (req, res) => {
  const product_type = req.params.product_type;

  if (!product_type) return res.status(400).json({ success: false, message: "Missing product_type" });

  try {
    // 1) Fetch EA plans. Some EA endpoints accept product_type directly; if not, we fallback to product_type=data
    let eaResponse;
    try {
      eaResponse = await axios.get(`${BASE_URL}/get_plans.php?product_type=${encodeURIComponent(product_type)}`, {
        headers: { AuthorizationToken: API_TOKEN },
        timeout: 15000,
      });
    } catch (err) {
      // fallback to fetching all data plans and filter later
      eaResponse = await axios.get(`${BASE_URL}/get_plans.php?product_type=data`, {
        headers: { AuthorizationToken: API_TOKEN },
        timeout: 15000,
      });
    }

    // EA returns grouped lists by network. Merge them into a single array
    const apiPlans = [
      ...(eaResponse.data?.MTN || []),
      ...(eaResponse.data?.GLO || []),
      ...(eaResponse.data?.AIRTEL || []),
      ...(eaResponse.data?.ETISALAT || []),
    ];

    // 2) Get custom prices rows for this product_type from DB
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

    // 3) Map EA plans and attach custom_price when available.
    // If EA response from specific product_type request includes only relevant plans this will match.
    const plans = apiPlans.map((p) => {
      const key = String(p.plan_id);
      const meta = priceMap[key];
      return {
        plan_id: p.plan_id,
        name: p.name ?? (meta ? meta.plan_name : ""),
        price: Number(p.amount ?? p.price ?? 0),
        validity: p.validity ?? "",
        custom_price: meta?.custom_price,
        api_price: meta?.api_price ?? undefined,
        last_api_price: meta?.last_api_price ?? undefined,
        raw: p,
      };
    });

    // Optionally filter: only return plans that exist in your custom_data_prices for this product_type
    // (This avoids showing irrelevant EA plans)
    const planIdsInDb = new Set(priceRows.map((r) => String(r.plan_id)));
    const filteredPlans = plans.filter((p) => planIdsInDb.has(String(p.plan_id)));

    return res.json({
      success: true,
      message: "Plans loaded successfully",
      product_type,
      plans: filteredPlans,
    });
  } catch (err) {
    console.error("vtu/plans error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ success: false, message: "Error fetching plans", error: err?.response?.data || err?.message });
  }
});

module.exports = router;
