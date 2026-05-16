"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const API_TOKEN = process.env.VTU_API_TOKEN || "3b2a7b74bc8bbe0878460122869864c5";
const BASE_URL = "https://easyaccessapi.com.ng/api/live/v1";

// ─────────────────────────────────────────────────────────────
// PRICING LOGIC
//
// Admin sets a MARKUP per plan (e.g. ₦5).
// Final price shown to user = provider_price + markup.
//
// Priority:
//   1. Per-plan markup  → stored in custom_data_prices.markup
//   2. Global markup    → stored in global_markup table, key = 'data'
//   3. Fallback         → provider_price + MIN_MARGIN (safety floor)
//
// custom_price column = the computed final (api_price + markup).
// This is what the purchase route reads — backend stays compatible.
// ─────────────────────────────────────────────────────────────

const MIN_MARGIN = 5; // ₦5 minimum profit on every plan

function computeCustomPrice(apiPrice, markup) {
  const base = Number(apiPrice);
  const m    = Number(markup) || 0;
  const final = base + m;
  // never let final price drop below provider + minimum margin
  return Math.max(final, base + MIN_MARGIN);
}

// ─── Fetch plans from EasyAccess ──────────────────────────────
async function fetchEAPlans(product_type) {
  const response = await axios.get(
    `${BASE_URL}/get-plans?product_type=${product_type}`,
    {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Cache-Control": "no-cache",
      },
      timeout: 10000,
    }
  );
  return (
    response.data?.MTN      ||
    response.data?.GLO      ||
    response.data?.AIRTEL   ||
    response.data?.["9MOBILE"] ||
    []
  );
}

// ─────────────────────────────────────────────────────────────
// GET /api/vtu/plans/:product_type
// Returns plans with ea_price + current markup + computed final
// ─────────────────────────────────────────────────────────────
router.get("/plans/:product_type", async (req, res) => {
  const { product_type } = req.params;

  try {
    const [apiPlans, customRows, globalRow] = await Promise.all([
      fetchEAPlans(product_type),
      db`
        SELECT plan_id, markup, custom_price, status
        FROM custom_data_prices
        WHERE product_type = ${product_type}
      `,
      db`
        SELECT markup FROM global_markup WHERE key = 'data' LIMIT 1
      `,
    ]);

    const globalMarkup = Number(globalRow[0]?.markup || 0);

    // Build lookup: plan_id → { markup, custom_price }
    const markupMap = {};
    customRows.forEach((row) => {
      if (row.status === "active") {
        markupMap[row.plan_id] = {
          markup: row.markup != null ? Number(row.markup) : null,
          custom_price: row.custom_price != null ? Number(row.custom_price) : null,
        };
      }
    });

    const plans = apiPlans.map((p) => {
      const apiPrice   = Number(p.price);
      const saved      = markupMap[p.plan_id];
      // use per-plan markup if set, else global markup
      const markup     = saved?.markup != null ? saved.markup : globalMarkup;
      const finalPrice = computeCustomPrice(apiPrice, markup);

      return {
        plan_id:      p.plan_id,
        name:         p.name,
        price:        apiPrice,       // raw EA price
        validity:     p.validity,
        markup:       markup,         // markup being applied
        custom_price: finalPrice,     // what user pays
      };
    });

    res.json({ success: true, product_type, plans });
  } catch (err) {
    console.error("❌ Fetch plans error:", err.message);
    res.status(500).json({ success: false, message: "Error fetching plans", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/vtu/global-markup
// Returns current global markup for data plans
// ─────────────────────────────────────────────────────────────
router.get("/global-markup", async (req, res) => {
  try {
    const rows = await db`SELECT markup FROM global_markup WHERE key = 'data' LIMIT 1`;
    res.json({ success: true, markup: Number(rows[0]?.markup || 0) });
  } catch (err) {
    console.error("❌ Get global markup error:", err.message);
    res.status(500).json({ success: false, message: "Failed to get global markup" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/vtu/global-markup
// Admin sets a global markup applied to ALL plans with no per-plan rule
// Body: { markup: number }
// ─────────────────────────────────────────────────────────────
router.post("/global-markup", async (req, res) => {
  const { markup } = req.body;

  if (markup == null || isNaN(Number(markup)) || Number(markup) < 0) {
    return res.status(400).json({ success: false, message: "markup must be a non-negative number" });
  }

  try {
    await db`
      INSERT INTO global_markup (key, markup, updated_at)
      VALUES ('data', ${Number(markup)}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET markup = EXCLUDED.markup, updated_at = NOW()
    `;
    res.json({ success: true, message: "Global markup updated", markup: Number(markup) });
  } catch (err) {
    console.error("❌ Set global markup error:", err.message);
    res.status(500).json({ success: false, message: "Failed to set global markup" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/vtu/plans/custom-price
// Admin sets markup on a SINGLE plan
// Body: { product_type, plan_id, plan_name, markup }
// ─────────────────────────────────────────────────────────────
router.post("/plans/custom-price", async (req, res) => {
  const { product_type, plan_id, plan_name, markup } = req.body;

  if (!product_type || !plan_id || !plan_name || markup == null) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  const markupVal = Number(markup);
  if (isNaN(markupVal) || markupVal < 0) {
    return res.status(400).json({ success: false, message: "markup must be a non-negative number" });
  }

  try {
    // Fetch live EA price to compute & store custom_price
    const apiPlans  = await fetchEAPlans(product_type);
    const plan      = apiPlans.find((p) => p.plan_id === plan_id);
    const apiPrice  = plan ? Number(plan.price) : 0;
    const finalPrice = computeCustomPrice(apiPrice, markupVal);

    await db`
      INSERT INTO custom_data_prices
        (product_type, plan_id, plan_name, api_price, markup, custom_price, status)
      VALUES
        (${product_type}, ${plan_id}, ${plan_name}, ${apiPrice}, ${markupVal}, ${finalPrice}, 'active')
      ON CONFLICT (product_type, plan_id) DO UPDATE
        SET markup       = EXCLUDED.markup,
            api_price    = EXCLUDED.api_price,
            custom_price = EXCLUDED.custom_price,
            status       = EXCLUDED.status,
            updated_at   = NOW()
    `;

    res.json({ success: true, message: "Markup saved", markup: markupVal, custom_price: finalPrice });
  } catch (err) {
    console.error("❌ Custom price update error:", err.message);
    res.status(500).json({ success: false, message: "Failed to update markup", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/vtu/plans/custom-price/bulk
// Admin sets markup on MULTIPLE plans at once
// Body: { product_type, plans: [{ plan_id, plan_name, markup }] }
// ─────────────────────────────────────────────────────────────
router.post("/plans/custom-price/bulk", async (req, res) => {
  const { product_type, plans } = req.body;

  if (!product_type || !Array.isArray(plans) || plans.length === 0) {
    return res.status(400).json({ success: false, message: "Provide product_type and plans array" });
  }

  try {
    // Fetch all live EA prices once
    const apiPlans = await fetchEAPlans(product_type);
    const apiMap   = {};
    apiPlans.forEach((p) => { apiMap[p.plan_id] = Number(p.price); });

    for (const plan of plans) {
      const { plan_id, plan_name, markup, status } = plan;
      if (!plan_id || markup == null) continue;

      const markupVal  = Number(markup);
      const apiPrice   = apiMap[plan_id] || 0;
      const finalPrice = computeCustomPrice(apiPrice, markupVal);

      await db`
        INSERT INTO custom_data_prices
          (product_type, plan_id, plan_name, api_price, markup, custom_price, status)
        VALUES
          (${product_type}, ${plan_id}, ${plan_name || plan_id}, ${apiPrice}, ${markupVal}, ${finalPrice}, ${status || "active"})
        ON CONFLICT (product_type, plan_id) DO UPDATE
          SET markup       = EXCLUDED.markup,
              api_price    = EXCLUDED.api_price,
              custom_price = EXCLUDED.custom_price,
              status       = EXCLUDED.status,
              updated_at   = NOW()
      `;
    }

    res.json({ success: true, message: "All markups saved successfully" });
  } catch (err) {
    console.error("❌ Bulk markup error:", err.message);
    res.status(500).json({ success: false, message: "Failed to save markups", error: err.message });
  }
});

module.exports = router;