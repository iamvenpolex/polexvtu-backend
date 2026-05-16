const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // postgres.js client
const router = express.Router();

const API_TOKEN = "3b2a7b74bc8bbe0878460122869864c5";
const BASE_URL = "https://easyaccessapi.com.ng/api/live/v1";

// ========================
// CONFIG: PRICE RULE
// ========================
const MIN_MARGIN = 5; // you earn at least ₦5 on every plan

function enforceMinimumPrice(apiPrice, customPrice) {
  const minAllowed = Number(apiPrice) + MIN_MARGIN;

  if (customPrice == null) return minAllowed;

  // NEVER allow below provider + margin
  if (customPrice < minAllowed) {
    return minAllowed;
  }

  return customPrice;
}

// ------------------------
// GET /plans/:product_type
// Returns EA price (static) + custom price (editable)
// ------------------------
router.get("/plans/:product_type", async (req, res) => {
  const { product_type } = req.params;

  try {
    console.log("🔹 Fetching plans for product_type:", product_type);

    const response = await axios.get(
      `${BASE_URL}/get-plans?product_type=${product_type}`,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Cache-Control": "no-cache",
        },
      }
    );

    const apiPlans =
      response.data?.MTN ||
      response.data?.GLO ||
      response.data?.AIRTEL ||
      response.data?.["9MOBILE"] ||
      [];

    const customRows = await db`
      SELECT plan_id, custom_price, status
      FROM custom_data_prices
      WHERE product_type = ${product_type}
    `;

    const priceMap = {};
    customRows.forEach((p) => {
      if (p.status === "active" && p.custom_price != null) {
        priceMap[p.plan_id] = Number(p.custom_price);
      }
    });

    const plansWithCustomPrice = apiPlans.map((p) => {
      const apiPrice = Number(p.price);
      const savedCustom = priceMap[p.plan_id];
      const safeCustomPrice = enforceMinimumPrice(apiPrice, savedCustom);

      return {
        plan_id: p.plan_id,
        name: p.name,
        price: apiPrice,
        validity: p.validity,
        custom_price: safeCustomPrice,
      };
    });

    console.log(
      "✅ Plans fetched successfully:",
      plansWithCustomPrice.length,
      "plans"
    );

    res.json({
      success: true,
      message: "Plans loaded successfully",
      product_type,
      plans: plansWithCustomPrice,
    });
  } catch (err) {
    console.error("❌ Fetch plans error:", err.message);
    res.status(500).json({
      success: false,
      message: "Error fetching plans",
      error: err.response?.data || err.message,
    });
  }
});

// ------------------------
// POST /plans/custom-price
// Save or update one custom price
// ------------------------
router.post("/plans/custom-price", async (req, res) => {
  const { product_type, plan_id, plan_name, custom_price, status } = req.body;

  if (!product_type || !plan_id || !plan_name || custom_price == null) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  try {
    const apiResponse = await axios.get(
      `${BASE_URL}/get-plans?product_type=${product_type}`,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
        },
      }
    );

    const apiPlans =
      apiResponse.data?.MTN ||
      apiResponse.data?.GLO ||
      apiResponse.data?.AIRTEL ||
      apiResponse.data?.["9MOBILE"] ||
      [];

    const plan = apiPlans.find((p) => p.plan_id === plan_id);
    const apiPrice = plan ? Number(plan.price) : 0;

    const safePrice = enforceMinimumPrice(apiPrice, Number(custom_price));

    const existing = await db`
      SELECT id FROM custom_data_prices
      WHERE product_type = ${product_type} AND plan_id = ${plan_id}
    `;

    if (existing.length > 0) {
      await db`
        UPDATE custom_data_prices
        SET custom_price = ${safePrice}, status = ${status || "active"}
        WHERE id = ${existing[0].id}
      `;
    } else {
      await db`
        INSERT INTO custom_data_prices
        (product_type, plan_id, plan_name, api_price, custom_price, status)
        VALUES (${product_type}, ${plan_id}, ${plan_name}, ${apiPrice}, ${safePrice}, ${
        status || "active"
      })
      `;
    }

    res.json({
      success: true,
      message: "Custom price updated successfully",
      final_price: safePrice,
    });
  } catch (err) {
    console.error("❌ Custom price update error:", err.message);
    res.status(500).json({
      success: false,
      message: "Failed to update custom price",
      error: err.message,
    });
  }
});

// ------------------------
// POST /plans/custom-price/bulk
// Save or update multiple custom prices at once
// ------------------------
router.post("/plans/custom-price/bulk", async (req, res) => {
  const { product_type, plans } = req.body;

  if (!product_type || !Array.isArray(plans) || plans.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid payload. Provide product_type and plans array.",
    });
  }

  try {
    const apiResponse = await axios.get(
      `${BASE_URL}/get-plans?product_type=${product_type}`,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
        },
      }
    );

    const apiPlans =
      apiResponse.data?.MTN ||
      apiResponse.data?.GLO ||
      apiResponse.data?.AIRTEL ||
      apiResponse.data?.["9MOBILE"] ||
      [];

    const apiMap = {};
    apiPlans.forEach((p) => {
      apiMap[p.plan_id] = Number(p.price);
    });

    for (const plan of plans) {
      const { plan_id, plan_name, custom_price, status } = plan;
      if (!plan_id || custom_price == null) continue;

      const apiPrice = apiMap[plan_id] || 0;
      const safePrice = enforceMinimumPrice(apiPrice, Number(custom_price));

      const existing = await db`
        SELECT id FROM custom_data_prices
        WHERE product_type = ${product_type} AND plan_id = ${plan_id}
      `;

      if (existing.length > 0) {
        await db`
          UPDATE custom_data_prices
          SET custom_price = ${safePrice}, status = ${status || "active"}
          WHERE id = ${existing[0].id}
        `;
      } else {
        await db`
          INSERT INTO custom_data_prices
          (product_type, plan_id, plan_name, api_price, custom_price, status)
          VALUES (${product_type}, ${plan_id}, ${plan_name}, ${apiPrice}, ${safePrice}, ${
        status || "active"
      })
        `;
      }
    }

    res.json({
      success: true,
      message: "All custom prices updated successfully",
    });
  } catch (err) {
    console.error("❌ Bulk custom price error:", err.message);
    res.status(500).json({
      success: false,
      message: "Failed to update custom prices",
      error: err.message,
    });
  }
});

module.exports = router;