// vtu.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

const API_TOKEN = "3b2a7b74bc8bbe0878460122869864c5"; // replace this
const BASE_URL = "https://easyaccessapi.com.ng/api";

// ✅ Get all plans based on product type
router.get("/plans/:product_type", async (req, res) => {
  const { product_type } = req.params;

  try {
    const response = await axios.get(
      `${BASE_URL}/get_plans.php?product_type=${product_type}`,
      {
        headers: {
          AuthorizationToken: API_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({
      success: true,
      data: response.data,
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching plans",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
