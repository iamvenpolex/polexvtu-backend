const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const router = express.Router();
const db = require("../config/db"); // MySQL connection

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

// ---------- VERIFY TV ----------
router.post("/verify", async (req, res) => {
  try {
    const { company, iucno } = req.body;

    if (!company || !iucno) {
      return res.status(400).json({ success: false, message: "Missing company or IUC number" });
    }

    const data = new FormData();
    data.append("company", company);
    data.append("iucno", iucno);

    console.log(`\n➡️ Sending VERIFY request to EasyAccess: company=${company}, iucno=${iucno}`);

    const response = await axios.post(`${BASE_URL}/verifytv.php`, data, {
      headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...data.getHeaders() },
    });

    console.log(`✅ EasyAccess VERIFY response:`, response.data);

    const eaData = response.data?.data || {};
    res.json({
      success: true,
      data: {
        account_name: eaData.account_name || "N/A",
        status: eaData.status || "N/A",
        ...eaData,
      },
    });
  } catch (error) {
    console.error("❌ EasyAccess VERIFY error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: "Failed to verify TV subscription" });
  }
});

// ---------- BUY TV ----------
router.post("/buy", async (req, res) => {
  try {
    const { company, iucno, packageId } = req.body;

    if (!company || !iucno || !packageId) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    // Get custom price
    const [rows] = await db.execute(
      `SELECT custom_price FROM custom_cabletv_prices WHERE company_code=? AND package_code=? AND status='active' LIMIT 1`,
      [company, packageId]
    );

    const maxAmountPayable = rows.length > 0 ? rows[0].custom_price : null;
    if (!maxAmountPayable) {
      return res.status(400).json({ success: false, message: "Custom price not set by admin" });
    }

    const data = new FormData();
    data.append("company", company);
    data.append("iucno", iucno);
    data.append("package", packageId);
    data.append("max_amount_payable", maxAmountPayable.toString());

    console.log(`\n➡️ Sending BUY request to EasyAccess: company=${company}, iucno=${iucno}, package=${packageId}, max_amount_payable=${maxAmountPayable}`);

    const response = await axios.post(`${BASE_URL}/paytv.php`, data, {
      headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...data.getHeaders() },
    });

    console.log(`✅ EasyAccess BUY response:`, response.data);

    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error("❌ EasyAccess BUY error:", error.response?.data || error.message);
    res.status(500).json({ success: false, message: "Purchase failed" });
  }
});

module.exports = router;
