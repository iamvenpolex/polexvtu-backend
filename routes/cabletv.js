const express = require("express");
const router = express.Router();
const axios = require("axios");

// Get TV plans dynamically
router.get("/plans", async (req, res) => {
  const { product_type } = req.query;
  if (!product_type) return res.status(400).json({ message: "product_type is required" });

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
    res.json(plans);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: "Failed to fetch plans" });
  }
});

// Verify IUC / Smart Card
router.post("/verify", async (req, res) => {
  const { company, iucno } = req.body;
  if (!company || !iucno) return res.status(400).json({ message: "company and iucno are required" });

  try {
    const response = await axios.post(
      "https://easyaccessapi.com.ng/api/verifytv.php",
      { company, iucno },
      {
        headers: {
          AuthorizationToken: process.env.EASY_ACCESS_TOKEN,
          "cache-control": "no-cache",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: "Failed to verify IUC" });
  }
});

// Pay / Subscribe TV
router.post("/subscribe", async (req, res) => {
  const { company, iucno, package, max_amount_payable } = req.body;
  if (!company || !iucno || !package) return res.status(400).json({ message: "Missing required parameters" });

  try {
    const response = await axios.post(
      "https://easyaccessapi.com.ng/api/paytv.php",
      { company, iucno, package, max_amount_payable },
      {
        headers: {
          AuthorizationToken: process.env.EASY_ACCESS_TOKEN,
          "cache-control": "no-cache",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: "Failed to subscribe TV" });
  }
});

module.exports = router;
