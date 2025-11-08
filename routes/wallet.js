const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db"); // Progress client
const jwt = require("jsonwebtoken");

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
    return res.status(401).json({ message: "Token invalid or expired. Login again" });
  }
};

// ------------------------
// GET Wallet Balance
// ------------------------
router.get("/balance", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const query = `SELECT first_name, last_name, balance, reward FROM users WHERE id = ${userId}`;
    const rows = await db.query(query);

    if (!rows || rows.length === 0)
      return res.status(404).json({ message: "User not found" });

    const user = rows[0];
    res.json({
      firstName: user.first_name,
      lastName: user.last_name,
      balance: parseFloat(user.balance) || 0,
      reward: parseFloat(user.reward) || 0,
    });
  } catch (error) {
    console.error("Balance error:", error);
    res.status(500).json({ message: "Please reload page" });
  }
});

// ------------------------
// POST Fund Wallet (Initialize Paystack)
// ------------------------
router.post("/fund", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, email } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount" });
    if (!email) return res.status(400).json({ message: "Email is required" });

    const koboAmount = amount * 100;

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        amount: koboAmount,
        email,
        callback_url: `${process.env.BACKEND_URL}/api/wallet/fund/callback`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const { authorization_url, reference } = response.data.data;

    // Save pending transaction
    const insertQuery = `
      INSERT INTO transactions (user_id, reference, amount, type, status)
      VALUES (${userId}, '${reference}', ${amount}, 'fund', 'pending')
    `;
    await db.query(insertQuery);

    res.json({ authorization_url, reference });
  } catch (error) {
    console.error("Fund init error:", error.response?.data || error.message);
    res.status(500).json({ message: "Failed to initialize payment" });
  }
});

// ------------------------
// GET: Backend Callback
// ------------------------
router.get("/fund/callback", async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).send("No reference provided");

  try {
    await verifyAndUpdate(reference);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/fund-wallet?status=success&reference=${reference}`);
  } catch (error) {
    console.error("Callback error:", error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/fund-wallet?status=failed&reference=${reference}`);
  }
});

// ------------------------
// Helper: Verify Payment & Update DB
// ------------------------
async function verifyAndUpdate(reference) {
  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );

  const { status, amount } = response.data.data;
  if (status !== "success") throw new Error("Payment not successful");

  const selectQuery = `SELECT user_id, status FROM transactions WHERE reference = '${reference}'`;
  const rows = await db.query(selectQuery);
  if (!rows || rows.length === 0) throw new Error("Transaction not found");

  const transaction = rows[0];
  if (transaction.status === "success") return;

  const userId = transaction.user_id;
  const nairaAmount = amount / 100;

  // Update transaction status
  const updateTrans = `
    UPDATE transactions
    SET status = 'success', amount = ${nairaAmount}
    WHERE reference = '${reference}'
  `;
  await db.query(updateTrans);

  // Update user's balance
  const updateBalance = `
    UPDATE users
    SET balance = balance + ${nairaAmount}
    WHERE id = ${userId}
  `;
  await db.query(updateBalance);
}

module.exports = router;
