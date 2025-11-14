require("dotenv").config(); // <-- Load .env at the top
const express = require("express");
const router = express.Router();
const db = require("../config/db"); // postgres client
const jwt = require("jsonwebtoken");
const axios = require("axios");

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
  } catch (error) {
    return res.status(401).json({ message: "Token invalid or expired" });
  }
};

// ------------------------
// Middleware: Admin Only
// ------------------------
const adminProtect = async (req, res, next) => {
  try {
    const users = await db`
      SELECT role FROM users WHERE id = ${req.user.id}
    `;
    if (!users.length || users[0].role !== "admin") {
      return res.status(403).json({ message: "Admin access only" });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// ------------------------
// POST: Admin Set SMS Price
// ------------------------
router.post("/set-price", protect, adminProtect, async (req, res) => {
  try {
    const { price } = req.body;
    if (!price || price <= 0)
      return res.status(400).json({ message: "Invalid price" });

    await db`
      INSERT INTO sms_pricing (price_per_sms, updated_at)
      VALUES (${price}, NOW())
    `;

    res.json({ message: "SMS price updated successfully", price });
  } catch (err) {
    console.error("Set price error:", err);
    res.status(500).json({ message: "Failed to set price" });
  }
});

// ------------------------
// GET: Get Current SMS Price
// ------------------------
router.get("/current-price", protect, async (req, res) => {
  try {
    const pricing = await db`
      SELECT price_per_sms FROM sms_pricing
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    res.json({ price: pricing[0]?.price_per_sms || 4 }); // default 4 N if none set
  } catch (err) {
    console.error("Get price error:", err);
    res.status(500).json({ message: "Failed to get price" });
  }
});

// ------------------------
// POST: Send SMS
// ------------------------
router.post("/send", protect, async (req, res) => {
  try {
    const { recipients, message, sender } = req.body;
    if (!recipients || !message || !sender)
      return res.status(400).json({ message: "Missing fields" });

    const numbers = recipients.split(",").map(n => n.trim());

    // Fetch user wallet balance
    const user = await db`
      SELECT balance FROM users WHERE id = ${req.user.id}
    `;
    if (!user.length) return res.status(404).json({ message: "User not found" });
    const balance = Number(user[0].balance) || 0;

    // Fetch current SMS price
    const pricing = await db`
      SELECT price_per_sms FROM sms_pricing
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    const pricePerSMS = Number(pricing[0]?.price_per_sms) || 4;
    const totalCost = numbers.length * pricePerSMS;

    if (balance < totalCost)
      return res.status(400).json({ message: `Insufficient balance. Total cost: N${totalCost}` });

    // Send SMS via SMSclone API with DND fallback
    const url = `https://smsclone.com/api/sms/dnd-fallback?username=${process.env.SMS_USERNAME}&password=${process.env.SMS_PASSWORD}&sender=${sender}&recipient=${numbers.join(",")}&message=${encodeURIComponent(message)}`;
    const response = await axios.get(url);
    const smsData = response.data; // batch response from SMSclone

    // Deduct wallet
    await db`
      UPDATE users SET balance = balance - ${totalCost} WHERE id = ${req.user.id}
    `;

    // Record transaction for each recipient
    const batchRecords = [];
    if (smsData.includes("|")) {
      const recipientsData = smsData.split(",");
      for (const item of recipientsData) {
        const parts = item.split("|");
        const statusCode = parts[0].split("-")[0];
        const recipientNumber = parts[1];
        const messageId = parts[2];
        const status = parts[3];
        const description = parts[4];

        batchRecords.push(
          db`
            INSERT INTO transactions (user_id, type, amount, status, details, recipient, message_id)
            VALUES (${req.user.id}, 'sms', ${pricePerSMS}, ${status}, ${description}, ${recipientNumber}, ${messageId})
          `
        );
      }
      await Promise.all(batchRecords);
    }

    res.json({
      message: "SMS sent successfully",
      smsResult: smsData,
      totalCost,
      pricePerSMS,
    });
  } catch (err) {
    console.error("Send SMS error:", err.response?.data || err.message);
    res.status(500).json({ message: "Failed to send SMS" });
  }
});

module.exports = router;
