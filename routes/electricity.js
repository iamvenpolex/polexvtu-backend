"use strict";

const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db"); // your users/wallet table

const EASYACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;

// POST /api/electricity/pay
router.post("/pay", async (req, res) => {
  try {
    const { user_id, company, metertype, meterno, amount } = req.body;

    // Validate input
    if (!user_id || !company || !metertype || !meterno || !amount)
      return res.status(400).json({ success: false, message: "Required fields missing" });

    if (amount < 1000)
      return res.status(400).json({ success: false, message: "Minimum amount is ₦1000" });

    // Check wallet balance
    const [user] = await db.execute("SELECT balance FROM users WHERE id = ?", [user_id]);
    if (!user || user[0].balance < amount)
      return res.status(400).json({ success: false, message: "Insufficient wallet balance" });

    // Deduct from wallet
    await db.execute("UPDATE users SET balance = balance - ? WHERE id = ?", [amount, user_id]);

    // Call EasyAccess API
    const response = await axios.post(
      "https://easyaccessapi.com.ng/api/payelectricity.php",
      { company, metertype, meterno, amount },
      { headers: { AuthorizationToken: EASYACCESS_TOKEN, "Content-Type": "application/json" } }
    );

    const data = response.data;
    const success = data.success === true || data.success === "true";

    if (success) {
      // Extract token depending on company
      const token =
        data.message.token ||
        data.message.mainToken ||
        data.message.Token ||
        null;

      return res.json({
        success: true,
        message: "Payment successful",
        token,
        full_response: data,
      });
    } else {
      // Refund wallet on failure
      await db.execute("UPDATE users SET balance = balance + ? WHERE id = ?", [amount, user_id]);

      return res.status(400).json({
        success: false,
        message: data.message || "Transaction failed",
      });
    }
  } catch (err) {
    console.error("Electricity pay error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;
