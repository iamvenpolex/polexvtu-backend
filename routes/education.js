// routes/education.js
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

    // ✅ Check if provider exists
    const rows = await db`
      SELECT id FROM education_prices WHERE provider = ${provider}
    `;

    if (rows.length === 0) {
      // ✅ Insert new record
      await db`
        INSERT INTO education_prices (provider, price, updated_at)
        VALUES (${provider}, ${numericPrice}, NOW())
      `;

      console.log(`[ADMIN] Inserted new price for ${provider}: ${numericPrice}`);
    } else {
      // ✅ Update existing record
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
// User buys pin (v1)
// ----------------------
router.post("/buy/:provider", async (req, res) => {
  try {
    const { provider } = req.params;
    const { user_id } = req.body;

    const validProviders = ["waec", "neco", "nabteb", "nbais"];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }

    // ✅ Fetch admin-set price
    const priceRows = await db`
      SELECT price FROM education_prices WHERE provider = ${provider}
    `;

    if (priceRows.length === 0) {
      return res.status(400).json({ success: false, message: "Price not set by admin" });
    }

    const price = Number(priceRows[0].price);

    // ✅ Check user wallet
    const userRows = await db`
      SELECT balance FROM users WHERE id = ${user_id}
    `;

    if (userRows.length === 0) {
      return res.status(400).json({ success: false, message: "User not found" });
    }

    const userBalance = Number(userRows[0].balance);
    if (userBalance < price) {
      return res.status(400).json({ success: false, message: "Insufficient user balance" });
    }

    // ✅ Deduct balance
    await db`
      UPDATE users SET balance = balance - ${price} WHERE id = ${user_id}
    `;

    // ✅ EasyAccess endpoints
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

    let pin;

    // ✅ If provider returned error → refund user
    if (typeof response.data === "object" && response.data.success === "false") {
      await db`
        UPDATE users SET balance = balance + ${price} WHERE id = ${user_id}
      `;

      return res.status(400).json({
        success: false,
        message: response.data.message,
      });
    } else {
      pin = response.data; // ✅ plain text PIN
    }

    return res.json({
      success: true,
      provider,
      price,
      pin,
    });

  } catch (err) {
    console.error("POST /api/education/buy/:provider error:", err.response?.data || err.message || err);

    return res.status(500).json({
      success: false,
      message: "Please try again",
    });
  }
});

module.exports = router;
