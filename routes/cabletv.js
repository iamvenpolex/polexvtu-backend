"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN || "YOUR_EASYACCESS_TOKEN";
const BASE_URL = "https://easyaccessapi.com.ng/api";

// GET /cabletv/plans/:company
// Example company: dstv, gotv, startimes, showmax
router.get("/plans/:company", async (req, res) => {
  const { company } = req.params;

  try {
    // Fetch plans from DB
    const [rows] = await db.query(
      "SELECT package_code, package_name, ea_price, custom_price, status FROM custom_cabletv_prices WHERE company_code = ? AND status='active'",
      [company]
    );

    if (!rows.length) {
      return res.json({
        success: false,
        message: "No plans found for this company",
        plans: [],
      });
    }

    const plans = rows.map((p) => ({
      package_code: p.package_code,
      package_name: p.package_name,
      ea_price: p.ea_price,
      custom_price: p.custom_price,
    }));

    return res.json({
      success: true,
      message: "Plans loaded successfully",
      company,
      plans,
    });
  } catch (err) {
    console.error("Load cable TV plans error:", err);
    return res.status(500).json({
      success: false,
      message: "Error fetching cable TV plans",
      error: err.message,
    });
  }
});

module.exports = router;
