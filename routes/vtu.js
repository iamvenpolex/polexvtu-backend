// routes/vtu.js
"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * Helper: flatten EA response into array of plans
 * EA returns { MTN: [...], GLO: [...], AIRTEL: [...], ETISALAT: [...] }
 */
function flattenEAPlans(eaRespData) {
  const arr = [];
  if (!eaRespData) return arr;
  if (Array.isArray(eaRespData)) return eaRespData; // rare case
  const keys = ["MTN", "GLO", "AIRTEL", "ETISALAT"];
  keys.forEach((k) => {
    if (eaRespData[k] && Array.isArray(eaRespData[k])) {
      eaRespData[k].forEach((p) => arr.push(p));
    }
  });
  return arr;
}

/**
 * GET /api/vtu/plans/:product_type
 * - Fetches plans from EasyAccess for given product_type
 * - Upserts plans into custom_data_prices (sets api_price, last_api_price)
 * - Inserts new rows with custom_price = api_price (admin can edit later)
 * - Disables DB rows for the product_type that are not present on EA
 * - Returns active plans for product_type
 */
router.get("/plans/:product_type", async (req, res) => {
  const product_type = req.params.product_type;
  if (!product_type) return res.status(400).json({ success: false, message: "Missing product_type" });

  try {
    // 1) Fetch from EA using the provided product_type (EA supports many product_type values)
    let eaResponse;
    try {
      eaResponse = await axios.get(`${BASE_URL}/get_plans.php?product_type=${encodeURIComponent(product_type)}`, {
        headers: { Authorization: API_TOKEN },
        timeout: 15000,
      });
    } catch (err) {
      // fallback: fetch all data plans and filter later (still useful)
      eaResponse = await axios.get(`${BASE_URL}/get_plans.php?product_type=data`, {
        headers: { Authorization: API_TOKEN },
        timeout: 15000,
      });
    }

    const eaPlans = flattenEAPlans(eaResponse.data);
    // Build a Map of plan_id => eaPlan
    const eaMap = new Map();
    eaPlans.forEach((p) => {
      eaMap.set(String(p.plan_id), {
        plan_id: String(p.plan_id),
        name: p.name ?? "",
        price: Number(p.price ?? p.amount ?? 0),
        validity: p.validity ?? "",
        raw: p,
      });
    });

    // 2) Load existing DB rows for this product_type
    const [dbRows] = await db.query(
      "SELECT id, product_type, plan_id, plan_name, api_price, last_api_price, custom_price, status FROM custom_data_prices WHERE product_type = ?",
      [product_type]
    );

    // 3) Upsert EA plans into DB (update api_price and last_api_price; insert new rows)
    for (const [planId, eaP] of eaMap.entries()) {
      const existing = dbRows.find((r) => String(r.plan_id) === String(planId));
      if (existing) {
        const lastApi = existing.api_price != null ? Number(existing.api_price) : null;
        // update last_api_price and api_price (do not overwrite custom_price)
        await db.query("UPDATE custom_data_prices SET last_api_price = ?, api_price = ?, status = 'active' WHERE id = ?", [
          lastApi,
          eaP.price,
          existing.id,
        ]);
      } else {
        // insert new plan, set custom_price = api_price by default (admin can edit later)
        await db.query(
          `INSERT INTO custom_data_prices (product_type, plan_id, plan_name, api_price, last_api_price, custom_price, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', NOW())`,
          [product_type, planId, eaP.name || "", eaP.price, eaP.price, eaP.price]
        );
      }
    }

    // 4) Disable DB plans for this product_type that are not found in EA
    // (Only disable if currently active)
    const toDisable = dbRows.filter((r) => !eaMap.has(String(r.plan_id)) && r.status === "active").map((r) => r.id);
    if (toDisable.length) {
      const placeholders = toDisable.map(() => "?").join(",");
      await db.query(`UPDATE custom_data_prices SET status = 'inactive' WHERE id IN (${placeholders})`, toDisable);
    }

    // 5) Return active plans from DB for product_type
    const [activeRows] = await db.query(
      "SELECT plan_id, plan_name, api_price, last_api_price, custom_price, status FROM custom_data_prices WHERE product_type = ? AND status = 'active'",
      [product_type]
    );

    const plans = activeRows.map((r) => ({
      plan_id: String(r.plan_id),
      name: r.plan_name,
      price: Number(r.api_price ?? 0),
      validity: "", // EA validity not stored; admin may edit
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
