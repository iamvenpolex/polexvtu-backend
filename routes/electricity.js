"use strict";

const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../config/db"); // postgres.js client

const EASYACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;

// --------------------- PAY ELECTRICITY ---------------------
router.post("/pay", async (req, res) => {
  try {
    const { user_id, company, metertype, meterno, amount } = req.body;

    if (!user_id || !company || !metertype || !meterno || !amount) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    if (amount < 1000) {
      return res.status(400).json({ success: false, message: "Minimum amount is ₦1000" });
    }

    // ✅ Check wallet balance
    const userRows = await db`
      SELECT balance FROM users WHERE id = ${user_id}
    `;

    if (!userRows || userRows.length === 0 || userRows[0].balance < amount) {
      return res.status(400).json({ success: false, message: "Insufficient wallet balance" });
    }

    const balanceBefore = Number(userRows[0].balance);
    const balanceAfter = balanceBefore - amount;

    // ✅ Deduct from wallet
    await db`
      UPDATE users SET balance = ${balanceAfter} WHERE id = ${user_id}
    `;

    // ✅ Call EasyAccess Pay API
    const response = await axios.post(
      "https://easyaccessapi.com.ng/api/payelectricity.php",
      { company, metertype, meterno, amount },
      { headers: { AuthorizationToken: EASYACCESS_TOKEN, "Content-Type": "application/json" } }
    );

    const data = response.data;
    console.log("EasyAccess PAY API Response:", JSON.stringify(data, null, 2));

    const success = data.success === true || data.success === "true";

    if (success) {
      const token = data.message.token || data.message.mainToken || data.message.Token || null;
      return res.json({
        success: true,
        message: "Payment successful",
        token,
        full_response: data,
      });
    } else {
      // ✅ Refund wallet on failure
      await db`
        UPDATE users SET balance = ${balanceBefore} WHERE id = ${user_id}
      `;

      return res.status(400).json({
        success: false,
        message: data.message || "Transaction failed",
        full_response: data,
      });
    }
  } catch (err) {
    console.error("Electricity pay error:", err.response?.data || err.message);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: err.response?.data || err.message,
    });
  }
});

// --------------------- VERIFY ELECTRICITY ---------------------
router.post("/verify", async (req, res) => {
  try {
    const { company, metertype, meterno, amount } = req.body;

    if (!company || !metertype || !meterno || !amount) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    if (amount < 1000) {
      return res.status(400).json({ success: false, message: "Minimum amount is ₦1000" });
    }

    // ✅ Call EasyAccess Verify API
    const response = await axios.post(
      "https://easyaccessapi.com.ng/api/verifyelectricity.php",
      { company, metertype, meterno, amount },
      { headers: { AuthorizationToken: EASYACCESS_TOKEN, "Content-Type": "application/json" } }
    );

    const data = response.data;
    console.log("EasyAccess VERIFY API Response:", JSON.stringify(data, null, 2));

    const success = data.success === true || data.success === "true";

    if (success) {
      const customer_name = data.message.content?.Customer_Name || null;
      return res.json({
        success: true,
        message: "Meter verified successfully",
        customer_name,
        full_response: data,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: data.message || "Verification failed",
        full_response: data,
      });
    }
  } catch (err) {
    console.error("Electricity verify error:", err.response?.data || err.message);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: err.response?.data || err.message,
    });
  }
});

module.exports = router;
