require("dotenv").config();
const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const { protect } = require("../middleware/authMiddleware"); 
const router = express.Router();

// -------------------------------------
// Helper: Get User Balance
// -------------------------------------
async function getUserBalance(userId) {
  const rows = await db`SELECT balance FROM users WHERE id = ${userId}`;
  return rows.length ? rows[0].balance : 0;
}

// -------------------------------------
// Helper: Save Transaction
// -------------------------------------
async function saveTransaction(data) {
  return await db`
    INSERT INTO transactions (
      user_id, reference, type, amount, status,
      balance_before, balance_after,
      network, plan, phone, via, description,
      api_amount, api_response, message_id
    )
    VALUES (
      ${data.user_id},
      ${data.reference},
      ${data.type},
      ${data.amount},
      ${data.status},
      ${data.balance_before},
      ${data.balance_after},
      ${data.network || null},
      ${data.plan || null},
      ${data.phone || null},
      ${data.via || "betting"},
      ${data.description || null},
      ${data.api_amount || null},
      ${data.api_response || null},
      ${data.message_id || null}
    )
    RETURNING *;
  `;
}

// -------------------------------------
// Helper: Update Transaction Status
// -------------------------------------
async function updateTransactionStatus(orderId, newStatus, description) {
  const rows = await db`
    UPDATE transactions
    SET status = ${newStatus}, description = ${description}
    WHERE reference = ${orderId}
    RETURNING *;
  `;
  return rows.length ? rows[0] : null;
}

// -------------------------------------
// Helper: Refund User
// -------------------------------------
async function refundUser(userId, amount) {
  const balance = await getUserBalance(userId);
  const newBalance = balance + Number(amount);

  await db`
    UPDATE users SET balance = ${newBalance}
    WHERE id = ${userId}
  `;

  return newBalance;
}

// -------------------------------------
// FUND BETTING WALLET
// Protected route
// -------------------------------------
router.post("/fund-wallet", protect, async (req, res) => {
  const userId = req.user.id;
  const { bettingCompany, customerId, amount, requestId, callbackUrl } = req.body;

  if (!bettingCompany || !customerId || !amount) {
    return res.status(400).json({
      success: false,
      message: "Betting company, Customer ID, and Amount are required.",
    });
  }

  const balanceBefore = await getUserBalance(userId);
  if (balanceBefore < Number(amount)) {
    return res.status(400).json({ success: false, message: "Insufficient balance" });
  }

  const API_USER = process.env.NELLO_USER_ID;
  const API_KEY = process.env.NELLO_API_KEY;

  const url = `https://www.nellobytesystems.com/APIBettingV1.asp?UserID=${API_USER}&APIKey=${API_KEY}&BettingCompany=${bettingCompany}&CustomerID=${customerId}&Amount=${amount}&RequestID=${requestId}&CallBackURL=${callbackUrl}`;

  try {
    const response = await axios.get(url);
    const api = response.data;

    // Save as pending
    await saveTransaction({
      user_id: userId,
      reference: api.OrderID || requestId,
      type: "betting",
      amount,
      status: "pending",
      balance_before: balanceBefore,
      balance_after: balanceBefore,
      network: bettingCompany,
      description: api.Remark || "Betting wallet funding initiated",
      api_amount: amount,
      api_response: api,
      message_id: api.OrderID
    });

    return res.json({
      success: true,
      status: "pending",
      message: "Transaction initiated",
      orderId: api.OrderID
    });

  } catch (error) {
    console.error("Funding Error:", error.message);

    await saveTransaction({
      user_id: userId,
      reference: requestId,
      type: "betting",
      amount,
      status: "failed",
      balance_before: balanceBefore,
      balance_after: balanceBefore,
      description: "API error",
      api_response: { error: error.message }
    });

    return res.status(500).json({ success: false, message: error.message });
  }
});

// -------------------------------------
// CALLBACK HANDLER
// Public route called by NelloBytes
// -------------------------------------
router.post("/callback", async (req, res) => {
  const data = req.body;
  const orderId = data.OrderID;
  const status = data.Status;

  const trx = await updateTransactionStatus(orderId, status.toLowerCase(), data.Remark);
  if (!trx) return res.json({ message: "Transaction not found" });

  // If completed → deduct balance
  if (status === "ORDER_COMPLETED") {
    const userBalance = await getUserBalance(trx.user_id);
    const newBalance = userBalance - Number(trx.amount);

    await db`
      UPDATE users SET balance = ${newBalance}
      WHERE id = ${trx.user_id}
    `;
    await db`
      UPDATE transactions SET balance_after = ${newBalance}
      WHERE reference = ${orderId}
    `;
  }

  // If cancelled → refund user
  if (status === "ORDER_CANCELLED") {
    const newBalance = await refundUser(trx.user_id, trx.amount);
    await db`
      UPDATE transactions SET balance_after = ${newBalance}
      WHERE reference = ${orderId}
    `;
  }

  return res.json({ success: true });
});

// -------------------------------------
// QUERY TRANSACTION
// Protected route
// -------------------------------------
router.get("/query/:orderId", protect, async (req, res) => {
  const { orderId } = req.params;

  const API_USER = process.env.NELLO_USER_ID;
  const API_KEY = process.env.NELLO_API_KEY;
  const url = `https://www.nellobytesystems.com/APIQueryV1.asp?UserID=${API_USER}&APIKey=${API_KEY}&OrderID=${orderId}`;

  try {
    const response = await axios.get(url);
    return res.json(response.data);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// -------------------------------------
// VERIFY CUSTOMER
// Public route
// -------------------------------------
router.get("/verify/:bettingCompany/:customerId", async (req, res) => {
  let { bettingCompany, customerId } = req.params;

  // Map frontend value to correct API code (case-sensitive)
  const bettingCompaniesMap = {
    msport: "MSPORT",
    naijabet: "NAIJABET",
    nairabet: "NAIRABET",
    "bet9ja-agent": "BET9JA-AGENT",
    betland: "BETLAND",
    betlion: "BETLION",
    supabet: "SUPABET",
    bet9ja: "BET9JA",
    bangbet: "BANGBET",
    betking: "BETKING",
    "1xbet": "1XBET",
    betway: "BETWAY",
    merrybet: "MERRYBET",
    mlotto: "MLOTTO",
    "western-lotto": "WESTERN-LOTTO",
    hallabet: "HALLABET",
    "green-lotto": "GREEN-LOTTO",
  };

  bettingCompany = bettingCompaniesMap[bettingCompany.toLowerCase()] || bettingCompany;

  const API_USER = process.env.NELLO_USER_ID;
  const API_KEY = process.env.NELLO_API_KEY;
  const url = `https://www.nellobytesystems.com/APIVerifyBettingV1.asp?UserID=${API_USER}&APIKey=${API_KEY}&BettingCompany=${bettingCompany}&CustomerID=${customerId}`;

  try {
    const response = await axios.get(url);

    const customerName = response.data.customer_name;
    const isValid = customerName && !customerName.toLowerCase().includes("error");

    return res.json({
      customer_name: customerName,
      valid: isValid,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
