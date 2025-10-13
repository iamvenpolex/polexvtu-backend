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
 * - Syncs plans from EasyAccess into custom_data_prices (upsert)
 * - Disables DB plans not present on EasyAccess
 * - Returns active plans for the product_type
 */
router.get("/plans/:product_type", async (req, res) => {
  const product_type = req.params.product_type;
  if (!product_type) return res.status(400).json({ success: false, message: "Missing product_type" });

  try {
    // 1) Fetch EA plans for the specific product_type. If that fails, fetch all data plans.
    let eaResponse;
    try {
      eaResponse = await axios.get(`${BASE_URL}/get_plans.php?product_type=${encodeURIComponent(product_type)}`, {
        headers: { AuthorizationToken: API_TOKEN },
        timeout: 15000,
      });
    } catch (err) {
      // fallback: fetch all data plans
      eaResponse = await axios.get(`${BASE_URL}/get_plans.php?product_type=data`, {
        headers: { AuthorizationToken: API_TOKEN },
        timeout: 15000,
      });
    }

    const eaPlans = [
      ...(eaResponse.data?.MTN || []),
      ...(eaResponse.data?.GLO || []),
      ...(eaResponse.data?.AIRTEL || []),
      ...(eaResponse.data?.ETISALAT || []),
    ];

    // Filter EA plans to only those whose product_type matches (EA sometimes returns many; we keep by plan_id existing in DB later)
    // Convert EA plans to map by plan_id for quick lookup
    const eaMap = new Map();
    eaPlans.forEach((p) => {
      eaMap.set(String(p.plan_id), {
        plan_id: String(p.plan_id),
        name: p.name,
        amount: Number(p.amount ?? p.price ?? 0),
        validity: p.validity ?? "",
        raw: p,
      });
    });

    // 2) Fetch DB rows for this product_type
    const [dbRows] = await db.query(
      "SELECT id, product_type, plan_id, plan_name, api_price, last_api_price, custom_price, status FROM custom_data_prices WHERE product_type = ?",
      [product_type]
    );

    const dbPlanIds = new Set(dbRows.map((r) => String(r.plan_id)));

    // 3) Upsert EA plans into DB for this product_type.
    // We'll upsert for any EA plan whose plan_id is present in EA (and optionally present in DB).
    // If a plan isn't in DB, we insert it and set custom_price = api_price (so it's immediately buyable).
    // If a plan is in DB, update api_price/last_api_price and keep existing custom_price (do not overwrite custom_price).
    for (const [planId, eaP] of eaMap.entries()) {
      // Only upsert if EA plan_id corresponds to product_type heuristically:
      // If DB already contains this planId for product_type OR product_type appears in planId (we assume admin previously set product_type)
      // We'll upsert anyway to ensure DB has latest EA plans for this product_type.
      // Check if row exists
      const row = dbRows.find((r) => String(r.plan_id) === String(planId));
      if (row) {
        // update api_price and last_api_price
        const lastApi = row.api_price != null ? Number(row.api_price) : null;
        await db.query(
          "UPDATE custom_data_prices SET last_api_price = ?, api_price = ? WHERE id = ?",
          [lastApi, eaP.amount, row.id]
        );
      } else {
        // insert new plan into DB with custom_price = ea price (admin can edit later)
        await db.query(
          `INSERT INTO custom_data_prices (product_type, plan_id, plan_name, api_price, last_api_price, custom_price, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
          [product_type, planId, eaP.name || "", eaP.amount, eaP.amount, eaP.amount, "active"]
        );
      }
    }

    // 4) Disable DB plans for this product_type that are not present on EA
    const toDisable = dbRows
      .filter((r) => !eaMap.has(String(r.plan_id)) && r.status === "active")
      .map((r) => r.id);

    if (toDisable.length) {
      const placeholders = toDisable.map(() => "?").join(",");
      await db.query(`UPDATE custom_data_prices SET status = 'inactive' WHERE id IN (${placeholders})`, toDisable);
    }

    // 5) Re-query DB for active plans to return to client
    const [activeRows] = await db.query(
      "SELECT plan_id, plan_name, api_price, last_api_price, custom_price, status FROM custom_data_prices WHERE product_type = ? AND status = 'active'",
      [product_type]
    );

    // Build response format consistent with frontend expectations
    const plans = activeRows.map((r) => ({
      plan_id: String(r.plan_id),
      name: r.plan_name,
      price: Number(r.api_price ?? 0),
      validity: "", // EA validity not stored here by default
      custom_price: r.custom_price != null ? Number(r.custom_price) : undefined,
      api_price: r.api_price != null ? Number(r.api_price) : undefined,
      last_api_price: r.last_api_price != null ? Number(r.last_api_price) : undefined,
    }));

    return res.json({ success: true, message: "Plans loaded and synced", product_type, plans });
  } catch (err) {
    console.error("vtu/plans error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ success: false, message: "Error fetching/syncing plans", error: err?.response?.data || err?.message });
  }
});

module.exports = router;
