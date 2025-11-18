const express = require("express");
const router = express.Router();
const axios = require("axios");

const USER_ID = "CK100589697";
const API_KEY = "H2T839OGR55M5827OVPU0IG545H69YX5NJRX0I46B82R445K9I91HOY3BEM7ZN81";

// Replace with your backend callback URL
const CALLBACK_URL = "https://yourdomain.com/api/airtime/callback";

// ---------- BUY AIRTIME ----------
router.get("/buy", async (req, res) => {
  try {
    const { network, amount, phone } = req.query;

    if (!network || !amount || !phone) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Generate unique RequestID
    const requestID = "REQ" + Date.now();

    const url = `https://www.nellobytesystems.com/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&MobileNetwork=${network}&Amount=${amount}&MobileNumber=${phone}&RequestID=${requestID}&CallBackURL=${CALLBACK_URL}`;

    const response = await axios.get(url);

    return res.json({
      success: true,
      requestID,
      response: response.data,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- QUERY ORDER ----------
router.get("/query", async (req, res) => {
  try {
    const { orderid, requestid } = req.query;

    if (!orderid && !requestid) {
      return res.status(400).json({ message: "Provide orderid or requestid" });
    }

    const url = `https://www.nellobytesystems.com/APIQueryV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}${orderid ? `&OrderID=${orderid}` : `&RequestID=${requestid}`}`;

    const response = await axios.get(url);

    return res.json({
      success: true,
      response: response.data,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- CALLBACK URL ----------
router.get("/callback", async (req, res) => {
  console.log("Airtime Callback Received:", req.query);

  // Example expected fields:
  // orderdate, orderid, statuscode, orderstatus, orderremark

  // TODO: Save to DB if needed
  // await db.save(req.query);

  return res.send("OK");
});

module.exports = router;
