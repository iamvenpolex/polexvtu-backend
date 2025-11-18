require("dotenv").config();
const express = require("express");
const router = express.Router();
const db = require("../config/db"); // Progress.js client
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");

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
const USER_ID = process.env.NELLO_USER_ID;
const API_KEY = process.env.NELLO_API_KEY;
const CALLBACK_URL = process.env.NELLO_CALLBACK_URL;

router.post("/buy", protect, async (req, res) => {
  try {
    const { network, amount, phone } = req.body;

    if (!network || !amount || !phone)
      return res.status(400).json({ error: "All fields are required" });

    const numericAmount = parseFloat(amount);
    if (numericAmount < 50)
      return res.status(400).json({ error: "Minimum amount is 50 Naira" });

    // --- Fetch user balance ---
    const user = await db.table("users").where({ id: req.user.id }).first();
    if (!user) return res.status(404).json({ error: "User not found" });

    const balanceBefore = parseFloat(user.balance || 0);
    if (balanceBefore < numericAmount)
      return res.status(400).json({ error: "Insufficient balance" });

    const balanceAfter = balanceBefore - numericAmount;

    // --- Insert transaction as pending ---
    const requestID = "REQ" + Date.now();
    const transaction = await db
      .table("transactions")
      .insert({
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
      })
      .returning("*");

    // --- Deduct user balance ---
    await db.table("users").where({ id: req.user.id }).update({ balance: balanceAfter });

    // --- Call NelloBytes API ---
    const url = `https://www.nellobytesystems.com/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&MobileNetwork=${network}&Amount=${numericAmount}&MobileNumber=${phone}&RequestID=${requestID}&CallBackURL=${CALLBACK_URL}`;
    const apiResponse = await axios.get(url);

    res.json({
      success: true,
      message: "Airtime purchase initiated",
      transaction: transaction,
      requestID,
      apiResponse: apiResponse.data,
      balanceAfter,
    });
  } catch (err) {
    console.error("Airtime buy error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
