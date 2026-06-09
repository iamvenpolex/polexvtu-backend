"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const API_TOKEN = process.env.VTU_API_TOKEN || "3b2a7b74bc8bbe0878460122869864c5";
const BASE_URL = "https://easyaccessapi.com.ng/api/live/v1";

const MIN_MARGIN = 5;

const ALL_PRODUCT_TYPES = [
  "mtn_sme", "mtn_cg_lite", "mtn_cg", "mtn_awoof", "mtn_gifting",
  "glo_cg", "glo_awoof", "glo_gifting",
  "airtel_cg", "airtel_awoof", "airtel_gifting",
  "9mobile_sme", "9mobile_gifting",
];

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

  // Provider returns data keyed by the product_type string directly
  // e.g. response.data?.mtn_sme or response.data?.MTN etc.
  // Try exact key first, then uppercase fallbacks
  const data = response.data;
  const plans =
    data?.[product_type] ||
    data?.MTN ||
    data?.GLO ||
    data?.AIRTEL ||
    data?.["9MOBILE"] ||
    [];

  return Array.isArray(plans) ? plans : [];
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
        AND status = 'active'
      `,
      db`
        SELECT markup FROM global_markup WHERE key = 'data' LIMIT 1
      `,
    ]);

    const globalMarkup = Number(globalRow[0]?.markup || 0);

    const markupMap = {};
    customRows.forEach((row) => {
      markupMap[row.plan_id] = {
        markup: row.markup != null ? Number(row.markup) : null,
      };
    });

    const plans = apiPlans.map((p) => {
      const apiPrice = Number(p.price);
      const saved = markupMap[p.plan_id];
      const markup = saved?.markup != null ? saved.markup : globalMarkup;

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
// BULK
// ─────────────────────────────────────────────
router.post("/plans/custom-price/bulk", async (req, res) => {
  const { product_type, plans } = req.body;

  if (!product_type || !Array.isArray(plans)) {
    return res.status(400).json({
      success: false,
      message: "Provide product_type and plans array",
    });
  }

  try {
    const apiPlansRaw = await fetchEAPlans(product_type);
    const apiPlans = Array.isArray(apiPlansRaw)
      ? apiPlansRaw
      : Object.values(apiPlansRaw).flat().filter(Boolean);

    const apiMap = new Map();
    apiPlans.forEach((p) => {
      if (p?.plan_id != null) {
        apiMap.set(String(p.plan_id), Number(p.price));
      }
    });

    await db`
      DELETE FROM custom_data_prices
      WHERE product_type = ${product_type}
    `;

    let saved = 0;
    const missing = [];

    for (const plan of plans) {
      const { plan_id, plan_name, markup, status } = plan;
      if (!plan_id) continue;

      const markupVal = Number(markup || 0);
      const apiPrice = apiMap.get(String(plan_id));

      if (apiPrice == null) {
        missing.push(plan_id);
        continue;
      }

      const finalPrice = computeCustomPrice(apiPrice, markupVal);

      await db`
        INSERT INTO custom_data_prices
          (product_type, plan_id, plan_name, api_price, markup, custom_price, status)
        VALUES
          (${product_type}, ${String(plan_id)}, ${plan_name || plan_id}, ${apiPrice}, ${markupVal}, ${finalPrice}, ${status || "active"})
      `;

      saved++;
    }

    return res.json({
      success: true,
      message: "Bulk replace completed successfully",
      saved,
      missing_from_api: missing,
    });
  } catch (err) {
    console.error("Bulk replace error:", err);
    return res.status(500).json({
      success: false,
      message: "Bulk save failed",
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// ADMIN: CHECK DB STATUS
// ─────────────────────────────────────────────
router.get("/admin/plans/status", async (req, res) => {
  try {
    const rows = await db`
      SELECT COUNT(*) AS total FROM custom_data_prices
    `;
    const total = Number(rows[0]?.total || 0);
    res.json({ success: true, hasPlans: total > 0, total });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to check plan status",
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// ADMIN: DELETE ALL PLANS
// ─────────────────────────────────────────────
router.delete("/admin/plans/all", async (req, res) => {
  try {
    const result = await db`
      DELETE FROM custom_data_prices RETURNING id
    `;
    res.json({
      success: true,
      message: `Deleted all ${result.length} plans successfully`,
      deleted: result.length,
    });
  } catch (err) {
    console.error("Delete all error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete all plans",
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// ADMIN: DELETE SINGLE PLAN BY ID
// ─────────────────────────────────────────────
router.delete("/admin/plans/single/:id", async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ success: false, message: "Invalid plan id" });
  }

  try {
    const result = await db`
      DELETE FROM custom_data_prices
      WHERE id = ${Number(id)}
      RETURNING id, plan_name
    `;

    if (!result.length) {
      return res.status(404).json({ success: false, message: "Plan not found" });
    }

    res.json({ success: true, message: `Plan "${result[0].plan_name}" deleted` });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to delete plan",
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// ADMIN: FULL SYNC
// Wipes all plans, re-fetches all product types, inserts as inactive
// ─────────────────────────────────────────────
router.post("/admin/plans/sync", async (req, res) => {
  let totalSynced = 0;
  const summary = {};

  try {
    // Step 1: Wipe everything
    await db`DELETE FROM custom_data_prices`;

    // Step 2: Fetch and re-insert for every product type
    for (const product_type of ALL_PRODUCT_TYPES) {
      try {
        const apiPlans = await fetchEAPlans(product_type);

        if (!Array.isArray(apiPlans) || !apiPlans.length) {
          summary[product_type] = { synced: 0, error: "No plans returned" };
          continue;
        }

        let networkCount = 0;

        for (const plan of apiPlans) {
          await db`
            INSERT INTO custom_data_prices (
              product_type, plan_id, plan_name, validity,
              api_price, custom_price, markup, status
            ) VALUES (
              ${product_type},
              ${String(plan.plan_id)},
              ${plan.name || String(plan.plan_id)},
              ${plan.validity || null},
              ${Number(plan.price)},
              ${Number(plan.price)},
              ${0},
              'inactive'
            )
          `;
          networkCount++;
        }

        summary[product_type] = { synced: networkCount };
        totalSynced += networkCount;
      } catch (networkErr) {
        console.error(`❌ Sync error for ${product_type}:`, networkErr.message);
        summary[product_type] = { synced: 0, error: networkErr.message };
      }
    }

    res.json({
      success: true,
      message: `Sync complete. ${totalSynced} plans inserted — all inactive. Review and activate before users can buy.`,
      total: totalSynced,
      summary,
      synced_at: new Date(),
    });
  } catch (err) {
    console.error("Full sync error:", err);
    res.status(500).json({
      success: false,
      message: "Full sync failed",
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// ADMIN: TOGGLE SINGLE PLAN STATUS
// ─────────────────────────────────────────────
router.patch("/admin/plans/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be 'active' or 'inactive'",
    });
  }

  try {
    const result = await db`
      UPDATE custom_data_prices
      SET status = ${status}, updated_at = NOW()
      WHERE id = ${Number(id)}
      RETURNING id, plan_name, status
    `;

    if (!result.length) {
      return res.status(404).json({ success: false, message: "Plan not found" });
    }

    res.json({
      success: true,
      message: `"${result[0].plan_name}" is now ${status}`,
      plan: result[0],
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to update status",
      error: err.message,
    });
  }
});

module.exports = router;