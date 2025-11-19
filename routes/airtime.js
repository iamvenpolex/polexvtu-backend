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
// Map Nello Status to Internal Status
// ------------------------
function mapNelloStatus(raw) {
  const { statuscode, status } = raw;

  if (statuscode === "200") return "success";
  if (statuscode === "100") return "pending";  // ORDER RECEIVED
  if (statuscode === "201") return "pending";  // ORDER ON HOLD
  if (statuscode === "402") return "failed";   // Vendor insufficient balance
  if (status === "ORDER_CANCELLED") return "cancelled";

  return "failed";
}

// ------------------------
// Buy Airtime Route
// ------------------------
router.post("/buy", protect, async (req, res) => {
  const client = db; // postgres.js client

  try {
    const { network, amount, phone } = req.body;

    if (!network || !amount || !phone)
      return res.status(400).json({ error: "All fields are required" });

    const numericAmount = Number(amount);
    if (numericAmount < 50)
      return res.status(400).json({ error: "Minimum amount is 50 Naira" });

    // Fetch user
    const [user] = await client`
      SELECT id, balance FROM users WHERE id = ${req.user.id}
    `;
    if (!user) return res.status(404).json({ error: "User not found" });

    const balanceBefore = Number(user.balance);
    if (balanceBefore < numericAmount)
      return res.status(400).json({ error: "Insufficient wallet balance" });

    const balanceAfter = balanceBefore - numericAmount;
    const requestID = "REQ" + Date.now();

    // --- Start transaction (atomic operations) ---
    await client.begin(async (sql) => {
      // Insert pending transaction
      await sql`
        INSERT INTO transactions (
          user_id, reference, type, amount, status, created_at,
          api_amount, network, phone, via, description,
          balance_before, balance_after
        ) VALUES (
          ${req.user.id}, ${requestID}, 'airtime', ${numericAmount}, 'pending', NOW(),
          ${numericAmount}, ${network}, ${phone}, 'wallet',
          ${`Airtime purchase for ${phone}`},
          ${balanceBefore}, ${balanceAfter}
        )
      `;

      // Deduct balance
      await sql`
        UPDATE users SET balance = ${balanceAfter} WHERE id = ${req.user.id}
      `;
    });
    // --- End atomic block ---

    // Call NelloByte API
    const url = `https://www.nellobytesystems.com/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&MobileNetwork=${network}&Amount=${numericAmount}&MobileNumber=${phone}&RequestID=${requestID}&CallBackURL=${CALLBACK_URL}`;

    const response = await axios.get(url);
    const raw = response.data;

    console.log("📡 Nello Response:", raw);

    // Map final status
    const finalStatus = mapNelloStatus(raw);

    // Update transaction status + store raw API response
    await client`
      UPDATE transactions
      SET status = ${finalStatus}, api_response = ${raw}
      WHERE reference = ${requestID}
    `;

    // If FAILED or CANCELLED → refund user
    if (["failed", "cancelled"].includes(finalStatus)) {
      await client`
        UPDATE users SET balance = ${balanceBefore}
        WHERE id = ${req.user.id}
      `;
    }

    return res.json({
      success: true,
      status: finalStatus,
      requestID,
      apiResponse: raw,
      balanceAfter: finalStatus === "success" ? balanceAfter : balanceBefore,
    });

  } catch (err) {
    console.error("❌ BUY AIRTIME ERROR:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
