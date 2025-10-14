const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const router = express.Router();

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN; // Your EasyAccess token
const BASE_URL = "https://easyaccessapi.com.ng/api";

// POST /api/buycabletv
router.post("/", async (req, res) => {
  try {
    const { company, iucno, packageId, maxAmountPayable } = req.body;

    if (!company || !iucno || !packageId || !maxAmountPayable) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const data = new FormData();
    data.append("company", company); // e.g., '01' for DSTV
    data.append("iucno", iucno);
    data.append("package", packageId);
    data.append("max_amount_payable", maxAmountPayable.toString());

    const response = await axios.post(`${BASE_URL}/paytv.php`, data, {
      headers: {
        AuthorizationToken: EASY_ACCESS_TOKEN,
        ...data.getHeaders(),
      },
    });

    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ success: false, message: "Purchase failed" });
  }
});

module.exports = router;
