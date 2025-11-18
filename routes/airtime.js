require("dotenv").config();
const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db"); // postgres.js client
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

    // --- Fetch user ---
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

    // --- Insert transaction as pending ---
    const requestID = "REQ" + Date.now();
    const transactionData = {
      user_id: req.user.id,
      reference: requestID,
      type: "airtime",
      amount: numericAmount,
      status: "pending",
      created_at: new Date(),
      api_amount: numericAmount,
      network,
      phone,
      via: "wallet",
      description: `Airtime purchase for ${phone}`,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
    };

    await db`
      INSERT INTO transactions ${db(transactionData)}
    `;

    // --- Deduct user balance ---
    await db`
      UPDATE users
      SET balance = ${balanceAfter}
      WHERE id = ${req.user.id}
    `;

    // --- Call NelloBytes API ---
    const url = `https://www.nellobytesystems.com/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&MobileNetwork=${network}&Amount=${numericAmount}&MobileNumber=${phone}&RequestID=${requestID}&CallBackURL=${CALLBACK_URL}`;
    const apiResponse = await axios.get(url);

    res.json({
      success: true,
      message: "Airtime purchase initiated",
      transaction: transactionData,
      requestID,
      apiResponse: apiResponse.data,
      balanceAfter,
    });
  } catch (err) {
    console.error("❌ Airtime buy error:", err.message);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
