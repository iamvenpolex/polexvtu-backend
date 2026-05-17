"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const API_TOKEN = process.env.VTU_API_TOKEN || "3b2a7b74bc8bbe0878460122869864c5";
const BASE_URL = "https://easyaccessapi.com.ng/api/live/v1";

const MIN_MARGIN = 5;

function computeCustomPrice(apiPrice, markup) {
  const base = Number(apiPrice);
  const m = Number(markup) || 0;
  const final = base + m;
  return Math.max(final, base + MIN_MARGIN);
}

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
    response.data?.MTN ||
    response.data?.GLO ||
    response.data?.AIRTEL ||
    response.data?.["9MOBILE"] ||
    []
  );
}

// ─────────────────────────────────────────────
// GET PLANS
// ─────────────────────────────────────────────
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

    const markupMap = {};
    customRows.forEach((row) => {
      if (row.status === "active") {
        markupMap[row.plan_id] = {
          markup: row.markup != null ? Number(row.markup) : null,
        };
      }
    });

    const plans = apiPlans.map((p) => {
      const apiPrice = Number(p.price);
      const saved = markupMap[p.plan_id];

      const markup =
        saved?.markup != null ? saved.markup : globalMarkup;

      return {
        plan_id: p.plan_id,
        name: p.name,
        price: apiPrice,
        validity: p.validity,
        markup,
        custom_price: computeCustomPrice(apiPrice, markup),
      };
    });

    res.json({ success: true, product_type, plans });
  } catch (err) {
    console.error("❌ Fetch plans error:", err.message);
    res.status(500).json({
      success: false,
      message: "Error fetching plans",
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// GLOBAL MARKUP GET
// ─────────────────────────────────────────────
router.get("/global-markup", async (req, res) => {
  try {
    const rows = await db`
      SELECT markup FROM global_markup WHERE key = 'data' LIMIT 1
    `;
    res.json({ success: true, markup: Number(rows[0]?.markup || 0) });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to get global markup",
    });
  }
});

// ─────────────────────────────────────────────
// GLOBAL MARKUP SET
// ─────────────────────────────────────────────
router.post("/global-markup", async (req, res) => {
  const { markup } = req.body;

  if (markup == null || isNaN(Number(markup)) || Number(markup) < 0) {
    return res.status(400).json({
      success: false,
      message: "markup must be a non-negative number",
    });
  }

  try {
    await db`
      INSERT INTO global_markup (key, markup, updated_at)
      VALUES ('data', ${Number(markup)}, NOW())
      ON CONFLICT (key) DO UPDATE
      SET markup = EXCLUDED.markup,
          updated_at = NOW()
    `;

    res.json({
      success: true,
      message: "Global markup updated",
      markup: Number(markup),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to set global markup",
    });
  }
});

// ─────────────────────────────────────────────
// SINGLE PLAN MARKUP
// ─────────────────────────────────────────────
router.post("/plans/custom-price", async (req, res) => {
  const { product_type, plan_id, plan_name, markup } = req.body;

  if (!product_type || !plan_id || !plan_name || markup == null) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  const markupVal = Number(markup);
  if (isNaN(markupVal) || markupVal < 0) {
    return res.status(400).json({
      success: false,
      message: "markup must be non-negative",
    });
  }

  try {
    const apiPlans = await fetchEAPlans(product_type);
    const plan = apiPlans.find((p) => p.plan_id === plan_id);

    const apiPrice = plan ? Number(plan.price) : 0;
    const finalPrice = computeCustomPrice(apiPrice, markupVal);

    await db`
      INSERT INTO custom_data_prices
        (product_type, plan_id, plan_name, api_price, markup, custom_price, status)
      VALUES
        (${product_type}, ${plan_id}, ${plan_name}, ${apiPrice}, ${markupVal}, ${finalPrice}, 'active')
      ON CONFLICT (product_type, plan_id) DO UPDATE
      SET markup = EXCLUDED.markup,
          api_price = EXCLUDED.api_price,
          custom_price = EXCLUDED.custom_price,
          status = EXCLUDED.status,
          updated_at = NOW()
    `;

    res.json({
      success: true,
      message: "Markup saved",
      custom_price: finalPrice,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to update markup",
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// BULK FIXED (NO PREPARED STATEMENT ISSUES)
// ─────────────────────────────────────────────
router.post("/plans/custom-price/bulk", async (req, res) => {
  const { product_type, plans } = req.body;

  if (!product_type || !Array.isArray(plans) || !plans.length) {
    return res.status(400).json({
      success: false,
      message: "Provide product_type and plans array",
    });
  }

  try {
    const apiPlans = await fetchEAPlans(product_type);

    const apiMap = {};
    apiPlans.forEach((p) => {
      apiMap[p.plan_id] = Number(p.price);
    });

    await db.begin(async (sql) => {
      for (const plan of plans) {
        const { plan_id, plan_name, markup, status } = plan;
        if (!plan_id || markup == null) continue;

        const markupVal = Number(markup);
        const apiPrice = apiMap[plan_id] || 0;
        const finalPrice = computeCustomPrice(apiPrice, markupVal);

        await sql`
          INSERT INTO custom_data_prices
            (product_type, plan_id, plan_name, api_price, markup, custom_price, status)
          VALUES
            (${product_type}, ${plan_id}, ${plan_name || plan_id}, ${apiPrice}, ${markupVal}, ${finalPrice}, ${status || "active"})
          ON CONFLICT (product_type, plan_id) DO UPDATE
          SET markup = EXCLUDED.markup,
              api_price = EXCLUDED.api_price,
              custom_price = EXCLUDED.custom_price,
              status = EXCLUDED.status,
              updated_at = NOW()
        `;
      }
    });

    res.json({
      success: true,
      message: "All markups saved successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to save markups",
      error: err.message,
    });
  }
});

module.exports = router;