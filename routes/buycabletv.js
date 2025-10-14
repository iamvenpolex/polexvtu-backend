const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const router = express.Router();
const db = require("../config/db"); // MySQL connection

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";

// ---------- VERIFY TV ----------
// POST /api/cabletv/verify
router.post("/verify", async (req, res) => {
  try {
    const { company, iucno } = req.body;

    if (!company || !iucno) {
      return res.status(400).json({ success: false, message: "Missing company or IUC number" });
    }

    const data = new FormData();
    data.append("company", company);
    data.append("iucno", iucno);

    const response = await axios.post(`${BASE_URL}/verifytv.php`, data, {
      headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...data.getHeaders() },
    });

    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to verify TV subscription" });
  }
});

// ---------- BUY TV ----------
// POST /api/cabletv/buy
router.post("/buy", async (req, res) => {
  try {
    const { company, iucno, packageId } = req.body;

    if (!company || !iucno || !packageId) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    // Get custom price from DB
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

    const response = await axios.post(`${BASE_URL}/paytv.php`, data, {
      headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...data.getHeaders() },
    });

    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Purchase failed" });
  }
});

module.exports = router;
