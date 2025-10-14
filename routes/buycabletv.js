"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN || "YOUR_EASYACCESS_TOKEN";
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * POST /buycabletv/verify
 * Verify IUC / Smart Card number
 * Required: company_code, iuc
 */
router.post("/verify", async (req, res) => {
  const { company_code, iuc } = req.body;

  if (!company_code || !iuc) {
    return res.status(400).json({
      success: false,
      message: "Company code and IUC number are required",
    });
  }

  try {
    const formData = new URLSearchParams();
    formData.append("company", company_code);
    formData.append("iucno", iuc);

    const response = await axios.post(`${BASE_URL}/verifytv.php`, formData, {
      headers: {
        AuthorizationToken: API_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.data.success) {
      return res.status(400).json({
        success: false,
        message: response.data.message || "IUC verification failed",
      });
    }

    // Return only customer name
    const customerName = response.data.message?.content?.Customer_Name || null;

    return res.json({
      success: true,
      message: "IUC verified successfully",
      customer_name: customerName,
      full_response: response.data.message,
    });
  } catch (err) {
    console.error("Verify IUC error:", err);
    return res.status(500).json({
      success: false,
      message: "Error verifying IUC",
      error: err.message,
    });
  }
});

/**
 * POST /buycabletv/pay
 * Purchase cable TV subscription
 * Required: company_code, iuc, package_code, max_amount_payable
 */
router.post("/pay", async (req, res) => {
  const { company_code, iuc, package_code, max_amount_payable } = req.body;

  if (!company_code || !iuc || !package_code || !max_amount_payable) {
    return res.status(400).json({
      success: false,
      message: "All fields are required",
    });
  }

  try {
    const formData = new URLSearchParams();
    formData.append("company", company_code);
    formData.append("iucno", iuc);
    formData.append("package", package_code);
    formData.append("max_amount_payable", max_amount_payable.toString());

    const response = await axios.post(`${BASE_URL}/paytv.php`, formData, {
      headers: {
        AuthorizationToken: API_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    return res.json(response.data);
  } catch (err) {
    console.error("Pay cable TV error:", err);
    return res.status(500).json({
      success: false,
      message: "Error processing cable TV subscription",
      error: err.message,
    });
  }
});

module.exports = router;
