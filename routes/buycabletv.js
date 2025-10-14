const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const router = express.Router();

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN; // Your EasyAccess token
const BASE_URL = "https://easyaccessapi.com.ng/api";

// Purchase Cable TV
router.post("/", async (req, res) => {
  try {
    const { company, iucno, packageId, maxAmountPayable } = req.body;

    // Optional: Adjust the price for your custom markup
    const userPrice = maxAmountPayable; // You can add your markup logic here

    const data = new FormData();
    data.append("company", company); // e.g., '01' for DSTV
    data.append("iucno", iucno);     // Customer IUC number
    data.append("package", packageId);
    data.append("max_amount_payable", userPrice);

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
