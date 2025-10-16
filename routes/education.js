const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const adminAuth = require("../middleware/adminAuth");

const router = express.Router();
const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;

// ✅ Fetch prices from EasyAccess + merge with admin custom pricing
router.get("/prices", async (req, res) => {
  try {
    console.log("🚀 Fetching education prices from EasyAccess...");

    const response = await axios.get(
      "https://easyaccessapi.com.ng/api/education",
      {
        headers: { Authorization: `Bearer ${EASY_ACCESS_TOKEN}` },
      }
    );

    console.log("✅ EasyAccess raw response:", JSON.stringify(response.data, null, 2));

    const easyAccessPrices = response.data?.data || [];

    console.log(`✅ Total prices received from EasyAccess: ${easyAccessPrices.length}`);

    const [customPrices] = await db.execute(
      "SELECT provider, base_price, profit, final_price FROM education_prices"
    );

    console.log("✅ Custom prices from admin DB:", customPrices);

    const finalPrices = easyAccessPrices.map((item) => {
      const cp = customPrices.find((p) => p.provider === item.name) || null;
      return {
        provider: item.name,
        base_price: item.amount,
        profit: cp ? cp.profit : 0,
        final_price: cp ? cp.final_price : item.amount,
      };
    });

    console.log("✅ Final merged prices:", finalPrices);

    res.json({ success: true, prices: finalPrices });
  } catch (err) {
    console.error("❌ Error fetching education prices:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: "Failed to load prices" });
  }
});

// ✅ Admin sets price + profit
router.post("/admin/set-price", adminAuth, async (req, res) => {
  try {
    console.log("🛠️ Admin request to set price:", req.body);

    const { provider, base_price, profit } = req.body;
    if (!provider || base_price === undefined || profit === undefined) {
      console.warn("⚠️ Missing required fields");
      return res.status(400).json({
        success: false,
        error: "provider, base_price & profit are required",
      });
    }

    const final_price = Number(base_price) + Number(profit);
    console.log(`💰 Calculated final price: ${final_price}`);

    await db.execute(
      `INSERT INTO education_prices (provider, base_price, profit, final_price)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE base_price=?, profit=?, final_price=?`,
      [
        provider,
        base_price,
        profit,
        final_price,
        base_price,
        profit,
        final_price,
      ]
    );

    console.log(`✅ Price saved for ${provider}`);

    res.json({
      success: true,
      message: `Price updated for ${provider}`,
    });
  } catch (err) {
    console.error("❌ Error setting education price:", err.message);
    res.status(500).json({ success: false, error: "Failed to set price" });
  }
});

module.exports = router;
