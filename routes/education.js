"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // ✅ postgres.js client
const router = express.Router();

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN || "";

// ----------------------
// Admin sets price
// ----------------------
router.put("/prices/:provider", async (req, res) => {
  try {
    const { provider } = req.params;
    const { price } = req.body;

    console.log(`[ADMIN] Setting price for provider: ${provider}, price: ${price}`);

    const validProviders = ["waec", "neco", "nabteb", "nbais"];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }

    const numericPrice = Number(price);
    if (isNaN(numericPrice)) {
      return res.status(400).json({ success: false, message: "Price must be a number" });
    }

    // Check if provider exists
    const rows = await db`
      SELECT id FROM education_prices WHERE provider = ${provider}
    `;

    if (rows.length === 0) {
      await db`
        INSERT INTO education_prices (provider, price, updated_at)
        VALUES (${provider}, ${numericPrice}, NOW())
      `;
      console.log(`[ADMIN] Inserted new price for ${provider}: ${numericPrice}`);
    } else {
      await db`
        UPDATE education_prices
        SET price = ${numericPrice}, updated_at = NOW()
        WHERE provider = ${provider}
      `;
      console.log(`[ADMIN] Updated price for ${provider}: ${numericPrice}`);
    }

    return res.json({ success: true, provider, price: numericPrice });
  } catch (err) {
    console.error("PUT /api/education/prices/:provider error:", err);
    return res.status(500).json({ success: false, message: "Please try again" });
  }
});

// ----------------------
// Frontend fetches prices
// ----------------------
router.get("/prices", async (req, res) => {
  try {
    const rows = await db`
      SELECT provider, price AS final_price FROM education_prices
    `;
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET /api/education/prices error:", err);
    return res.status(500).json({ success: false, message: "Please try again" });
  }
});

// ----------------------
// User buys pin
// ----------------------
router.post("/buy/:provider", async (req, res) => {
  try {
    const { provider } = req.params;
    const { user_id } = req.body;

    const validProviders = ["waec", "neco", "nabteb", "nbais"];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }

    // Fetch admin-set price
    const priceRows = await db`
      SELECT price FROM education_prices WHERE provider = ${provider}
    `;
    if (priceRows.length === 0) {
      return res.status(400).json({ success: false, message: "Price not set by admin" });
    }

    const price = Number(priceRows[0].price);

    // Check user wallet
    const userRows = await db`
      SELECT balance FROM users WHERE id = ${user_id}
    `;
    if (userRows.length === 0) {
      return res.status(400).json({ success: false, message: "User not found" });
    }

    if (userRows[0].balance < price) {
      return res.status(400).json({ success: false, message: "Insufficient user balance" });
    }

    // Deduct balance
    await db`
      UPDATE users SET balance = balance - ${price} WHERE id = ${user_id}
    `;

    // EasyAccess API endpoints
    const endpointMap = {
      waec: "https://easyaccessapi.com.ng/api/waec.php",
      neco: "https://easyaccessapi.com.ng/api/neco.php",
      nabteb: "https://easyaccessapi.com.ng/api/nabteb.php",
      nbais: "https://easyaccessapi.com.ng/api/nbais.php",
    };

    const response = await axios.get(endpointMap[provider], {
      headers: {
        AuthorizationToken: EASY_ACCESS_TOKEN,
        "cache-control": "no-cache",
      },
      timeout: 10000,
    });

    console.log(`[EDUCATION] EasyAccess API response for ${provider}:`, response.data);

    // If provider returned error → refund user
    if (typeof response.data === "object" && response.data.success === "false") {
      await db`
        UPDATE users SET balance = balance + ${price} WHERE id = ${user_id}
      `;
      return res.status(400).json({
        success: false,
        message: response.data.message,
      });
    }

    const pinValue = response.data; // plain text PIN

    // Save token in tokens table
    await db`
      INSERT INTO tokens (user_id, provider, transaction_type, token_value, amount)
      VALUES (${user_id}, ${provider}, 'education', ${pinValue}, ${price})
    `;

    return res.json({
      success: true,
      provider,
      price,
      pin: pinValue,
    });

  } catch (err) {
    console.error("POST /api/education/buy/:provider error:", err.response?.data || err.message || err);
    return res.status(500).json({ success: false, message: "Please try again" });
  }
});

// ----------------------
// Fetch user education history
// ----------------------
router.get("/history/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    const rows = await db`
      SELECT id, provider, transaction_type, token_value, reference, amount, status, created_at
      FROM tokens
      WHERE user_id = ${user_id} AND transaction_type = 'education'
      ORDER BY created_at DESC
    `;

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET /tokens/history error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch history" });
  }
});

module.exports = router;
