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
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }

    const numericPrice = Number(price);
    if (isNaN(numericPrice)) {
      return res.status(400).json({ success: false, message: "Price must be a number" });
    }

    const [rows] = await db.query("SELECT id FROM education_prices WHERE provider = ?", [provider]);
    if (rows.length === 0) {
      await db.query("INSERT INTO education_prices (provider, price, updated_at) VALUES (?, ?, NOW())", [provider, numericPrice]);
      console.log(`[ADMIN] Inserted new price for ${provider}: ${numericPrice}`);
    } else {
      await db.query("UPDATE education_prices SET price = ?, updated_at = NOW() WHERE provider = ?", [numericPrice, provider]);
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
    const [rows] = await db.query("SELECT provider, price AS final_price FROM education_prices");
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET /api/education/prices error:", err);
    return res.status(500).json({ success: false, message: "Please try again" });
  }
});

// ----------------------
// User buys pin (v1, 1 pin only)
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
    const [priceRows] = await db.query("SELECT price FROM education_prices WHERE provider = ?", [provider]);
    if (!priceRows.length) return res.status(400).json({ success: false, message: "Price not set by admin" });

    const price = Number(priceRows[0].price);

    // Check user wallet
    const [userRows] = await db.query("SELECT balance FROM users WHERE id = ?", [user_id]);
    if (!userRows.length) return res.status(400).json({ success: false, message: "User not found" });

    const userBalance = Number(userRows[0].balance);
    if (userBalance < price) return res.status(400).json({ success: false, message: "Insufficient user balance" });

    // Deduct user balance
    await db.query("UPDATE users SET balance = balance - ? WHERE id = ?", [price, user_id]);

   // Call EasyAccess API
const endpointMap = {
  waec: "https://easyaccessapi.com.ng/api/waec.php",
  neco: "https://easyaccessapi.com.ng/api/neco.php",
  nabteb: "https://easyaccessapi.com.ng/api/nabteb.php",
  nbais: "https://easyaccessapi.com.ng/api/nbais.php",
};

const response = await axios.get(endpointMap[provider], {
  headers: { AuthorizationToken: EASY_ACCESS_TOKEN, "cache-control": "no-cache" },
  timeout: 10000,
});

// 🔹 Log full EasyAccess response
console.log(`[EDUCATION] EasyAccess API response for ${provider}:`, response.data);

// Handle EasyAccess response
let pin;
if (typeof response.data === "object" && response.data.success === "false") {
  // Refund user
  await db.query("UPDATE users SET balance = balance + ? WHERE id = ?", [price, user_id]);
  return res.status(400).json({ success: false, message: response.data.message });
} else {
  pin = response.data; // Plain text pin
}

    return res.json({ success: true, provider, price, pin });
  } catch (err) {
    console.error("POST /api/education/buy/:provider error:", err.response?.data || err.message || err);
    return res.status(500).json({ success: false, message: "Please try again" });
  }
});

module.exports = router;
