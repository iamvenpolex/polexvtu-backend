const express = require("express");
const router = express.Router();
const axios = require("axios");

// GET TV plans
router.get("/", async (req, res) => {
  const { product_type } = req.query;

  if (!product_type) {
    return res.status(400).json({ message: "product_type is required" });
  }

  try {
    const response = await axios.get(
      `https://easyaccessapi.com.ng/api/get_plans.php?product_type=${product_type}`,
      {
        headers: {
          AuthorizationToken: process.env.EASY_ACCESS_TOKEN,
          "cache-control": "no-cache",
        },
      }
    );

    const plans = response.data.message || response.data;
    res.status(200).json(plans);
  } catch (error) {
    console.error("Error fetching plans:", error.message);
    res.status(500).json({ message: "Failed to fetch plans" });
  }
});

module.exports = router;
