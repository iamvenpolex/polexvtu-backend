// routes/education.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // mysql2/promise pool
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
      console.log("[ADMIN] Invalid provider");
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }

    const numericPrice = Number(price);
    if (isNaN(numericPrice)) {
      console.log("[ADMIN] Price is not a number");
      return res.status(400).json({ success: false, message: "Price must be a number" });
    }

    // upsert price
    const [rows] = await db.query("SELECT id FROM education_prices WHERE provider = ?", [provider]);
    if (rows.length === 0) {
      await db.query(
        "INSERT INTO education_prices (provider, price, updated_at) VALUES (?, ?, NOW())",
        [provider, numericPrice]
      );
      console.log(`[ADMIN] Inserted new price for ${provider}: ${numericPrice}`);
    } else {
      await db.query(
        "UPDATE education_prices SET price = ?, updated_at = NOW() WHERE provider = ?",
        [numericPrice, provider]
      );
      console.log(`[ADMIN] Updated price for ${provider}: ${numericPrice}`);
    }

    return res.json({ success: true, provider, price: numericPrice });
  } catch (err) {
    console.error("PUT /api/education/prices/:provider error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ----------------------
// Frontend fetches prices
// ----------------------
router.get("/prices", async (req, res) => {
  try {
    console.log("[FETCH] Fetching all education prices");
    const [rows] = await db.query("SELECT provider, price AS final_price FROM education_prices");
    console.log("[FETCH] Prices fetched:", rows);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET /api/education/prices error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ----------------------
// User buys pin (v1, 1 pin only)
// ----------------------
router.post("/buy/:provider", async (req, res) => {
  try {
    const { provider } = req.params;
    const validProviders = ["waec", "neco", "nabteb", "nbais"];
    if (!validProviders.includes(provider)) {
      console.log("[BUY] Invalid provider:", provider);
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }

    // fetch admin-set price
    const [rows] = await db.query("SELECT price FROM education_prices WHERE provider = ?", [provider]);
    if (!rows.length) {
      console.log("[BUY] Price not set by admin for provider:", provider);
      return res.status(400).json({ success: false, message: "Price not set by admin" });
    }

    const price = Number(rows[0].price);
    console.log(`[BUY] Admin price for ${provider}: ${price}`);

    // EasyAccess v1 GET endpoints
    const endpointMap = {
      waec: "https://easyaccessapi.com.ng/api/waec.php",
      neco: "https://easyaccessapi.com.ng/api/neco.php",
      nabteb: "https://easyaccessapi.com.ng/api/nabteb.php",
      nbais: "https://easyaccessapi.com.ng/api/nbais.php",
    };

    console.log(`[BUY] Calling EasyAccess API for ${provider}...`);

    const response = await axios.get(endpointMap[provider], {
      headers: {
        AuthorizationToken: EASY_ACCESS_TOKEN,
        "cache-control": "no-cache",
      },
      timeout: 10000,
    });

    console.log(`[BUY] EasyAccess response for ${provider}:`, response.data);

    // success: pin returned as plain text
    return res.json({ success: true, provider, price, pin: response.data });
  } catch (err) {
    console.error(
      "POST /api/education/buy/:provider error:",
      err.response?.data || err.message || err
    );
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
