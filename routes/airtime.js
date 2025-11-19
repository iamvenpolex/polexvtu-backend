require("dotenv").config();
const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

const USER_ID = process.env.NELLO_USER_ID;
const API_KEY = process.env.NELLO_API_KEY;
const CALLBACK_URL = process.env.NELLO_CALLBACK_URL;

// ------------------------
// Middleware: Protect Routes
// ------------------------
const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "Not authorized" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Not authorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token invalid or expired" });
  }
};

// ------------------------
// Airtime Purchase Route
// ------------------------
router.post("/buy", protect, async (req, res) => {
  try {
    const { network, amount, phone } = req.body;

    if (!network || !amount || !phone)
      return res.status(400).json({ error: "All fields are required" });

    const numericAmount = parseFloat(amount);
    if (numericAmount < 50)
      return res.status(400).json({ error: "Minimum amount is 50 Naira" });

    // Fetch user
    const userRows = await db`
      SELECT id, balance
      FROM users
      WHERE id = ${req.user.id}
    `;
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    const balanceBefore = parseFloat(user.balance || 0);
    if (balanceBefore < numericAmount)
      return res.status(400).json({ error: "Insufficient balance" });

    const balanceAfter = balanceBefore - numericAmount;

    // Insert transaction
    const requestID = "REQ" + Date.now();
    await db`
      INSERT INTO transactions (
        user_id, reference, type, amount, status, created_at, 
        api_amount, network, phone, via, description, 
        balance_before, balance_after
      ) VALUES (
        ${req.user.id}, ${requestID}, 'airtime', ${numericAmount}, 'pending', ${new Date()},
        ${numericAmount}, ${network}, ${phone}, 'wallet', ${`Airtime purchase for ${phone}`},
        ${balanceBefore}, ${balanceAfter}
      )
    `;

    // Deduct user balance
    await db`UPDATE users SET balance = ${balanceAfter} WHERE id = ${req.user.id}`;

    // Call API
    const url = `https://www.nellobytesystems.com/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&MobileNetwork=${network}&Amount=${numericAmount}&MobileNumber=${phone}&RequestID=${requestID}&CallBackURL=${CALLBACK_URL}`;
    const nellyResponse = await axios.get(url);

    const raw = nellyResponse.data;

    // Parse response
    let apiCode = null;
    let statusText = "";
    let remark = "";

    if (typeof raw === "string") {
      const parts = raw.split("|");
      apiCode = parseInt(parts[0]);
      statusText = parts[1];
      remark = parts[2];
    }

    let status = "pending";

    // Status mapping
    if (apiCode === 200) status = "success";
    else if (apiCode === 201 || (apiCode >= 600 && apiCode <= 699)) status = "pending";
    else if ((apiCode >= 400 && apiCode <= 499) || apiCode === 299) status = "failed";
    else if (apiCode >= 500 && apiCode <= 599) status = "cancelled";

    // Update DB
    await db`
      UPDATE transactions
      SET status = ${status}, api_response = ${raw}
      WHERE reference = ${requestID}
    `;

    // Refund on failure/cancelled
    if (status === "failed" || status === "cancelled") {
      await db`UPDATE users SET balance = ${balanceBefore} WHERE id = ${req.user.id}`;
    }

    return res.json({
      success: true,
      status,
      requestID,
      apiResponse: raw,
      balanceAfter: status === "success" ? balanceAfter : balanceBefore,
    });

  } catch (err) {
    console.error("❌ Airtime buy error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
