const express = require("express");
const axios = require("axios");
const router = express.Router();

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN; // Your EasyAccess token
const BASE_URL = "https://easyaccessapi.com.ng/api";

// GET /api/cabletv/:company
router.get("/:company", async (req, res) => {
  try {
    const { company } = req.params; // dstv, gotv, startimes, showmax
    const response = await axios.get(`${BASE_URL}/get_plans.php?product_type=${company}`, {
      headers: {
        AuthorizationToken: EASY_ACCESS_TOKEN,
        "cache-control": "no-cache",
      },
    });

    // Send plans in JSON
    res.json({
      success: true,
      plans: response.data[company.toUpperCase()],
    });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ success: false, message: "Failed to fetch plans" });
  }
});

module.exports = router;
