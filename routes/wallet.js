const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

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
    const users = await db`
      SELECT first_name, last_name, balance, reward
      FROM users
      WHERE id = ${req.user.id}
    `;
    if (!users.length) return res.status(404).json({ message: "User not found" });

    const user = users[0];
    res.json({
      firstName: user.first_name,
      lastName: user.last_name,
      balance: Number(user.balance) || 0,
      reward: Number(user.reward) || 0,
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

    if (!amount || amount <= 0)
      return res.status(400).json({ message: "Invalid amount" });
    if (!email)
      return res.status(400).json({ message: "Email is required" });

    const koboAmount = Math.round(amount * 100);

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

    // Fetch current balance for balance_before
    const users = await db`SELECT balance FROM users WHERE id = ${userId}`;
    const balanceBefore = Number(users[0]?.balance || 0);

    // Save pending transaction with all required fields
    await db`
      INSERT INTO transactions (
        user_id, reference, type, amount, status,
        description, balance_before, balance_after,
        amount_paid, settlement_fee, settlement_amount,
        via, created_at, updated_at
      ) VALUES (
        ${userId}, ${reference}, 'fund', ${amount}, 'pending',
        'Wallet funding via Paystack', ${balanceBefore}, ${balanceBefore},
        0, 0, 0,
        'paystack', NOW(), NOW()
      )
    `;

    res.json({ authorization_url, reference });
  } catch (error) {
    console.error("Fund init error:", error.response?.data || error.message);
    res.status(500).json({ message: "Failed to initialize payment" });
  }
});

// ------------------------
// GET: Paystack Callback
// ------------------------
router.get("/fund/callback", async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).send("No reference provided");

  try {
    await verifyAndUpdate(reference);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/wallet/fund/callback?status=success&reference=${reference}`
    );
  } catch (error) {
    console.error("Callback error:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/wallet/fund/callback?status=failed&reference=${reference}`
    );
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

  const paystackData = response.data.data;
  if (paystackData.status !== "success") throw new Error("Payment not successful");

  // Amounts from Paystack (in kobo → convert to naira)
  const amountPaid       = paystackData.amount / 100;
  const settlementFee    = (paystackData.fees || 0) / 100;
  const settlementAmount = amountPaid - settlementFee;

  // Fetch the pending transaction
  const transactions = await db`
    SELECT id, user_id, status, balance_before
    FROM transactions
    WHERE reference = ${reference}
  `;
  if (!transactions.length) throw new Error("Transaction not found");

  const transaction = transactions[0];
  if (transaction.status === "success") return; // Already processed — idempotent

  const userId        = transaction.user_id;
  const balanceBefore = Number(transaction.balance_before);
  const balanceAfter  = balanceBefore + amountPaid;

  // Update transaction with full details
  await db`
    UPDATE transactions
    SET
      status            = 'success',
      amount            = ${amountPaid},
      amount_paid       = ${amountPaid},
      settlement_fee    = ${settlementFee},
      settlement_amount = ${settlementAmount},
      balance_after     = ${balanceAfter},
      provider_reference = ${paystackData.id?.toString() || null},
      provider_status   = ${paystackData.status},
      api_response      = ${JSON.stringify(paystackData)},
      updated_at        = NOW()
    WHERE reference = ${reference}
  `;

  // Credit user wallet
  await db`
    UPDATE users
    SET balance = ${balanceAfter}
    WHERE id = ${userId}
  `;
}

// ------------------------
// GET: Verify Transaction (Frontend Polling)
// ------------------------
router.get("/verify-transaction", protect, async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ message: "Reference missing" });

  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    const { status } = response.data.data;
    return res.json({ status });
  } catch (error) {
    console.error("Verification error:", error.response?.data || error.message);
    res.status(500).json({ message: "Verification failed" });
  }
});

// ------------------------
// POST: Paystack Webhook (Live)
// ------------------------
router.post("/fund/webhook", async (req, res) => {
  try {
    // Verify webhook signature from Paystack
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      console.warn("⚠️ Invalid Paystack webhook signature");
      return res.sendStatus(401);
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const reference = event.data.reference;
      try {
        await verifyAndUpdate(reference);
        console.log(`✅ Webhook processed: ${reference}`);
      } catch (err) {
        console.error("Webhook verify error:", err.message);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

module.exports = router;