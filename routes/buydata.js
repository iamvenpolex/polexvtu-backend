// buydata.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // MySQL connection
const router = express.Router();

const API_TOKEN = "3b2a7b74bc8bbe0878460122869864c5";
const BASE_URL = "https://easyaccessapi.com.ng/api";

/**
 * POST /buydata
 * User buys data. Deducts user's balance, calls EasyAccess API, stores transaction.
 * Body: { user_id, network, mobile_no, dataplan }
 */
router.post("/", async (req, res) => {
  const { user_id, network, mobile_no, dataplan } = req.body;

  if (!user_id || !network || !mobile_no || !dataplan) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    const [plans] = await db.query(
      "SELECT custom_price FROM custom_data_prices WHERE plan_id = ? AND status='active'",
      [dataplan]
    );
    if (!plans.length) return res.status(400).json({ success: false, message: "Plan not available" });
    const price = plans[0].custom_price;

    if (user.balance < price) return res.status(400).json({ success: false, message: "Insufficient balance" });

    const reference = `CL${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await db.query("UPDATE users SET balance = balance - ? WHERE id = ?", [price, user.id]);
    
    // Store transaction with pending status and api_amount = 0
    await db.query(
      "INSERT INTO transactions (user_id, reference, type, amount, api_amount, status) VALUES (?, ?, 'purchase', ?, 0, 'pending')",
      [user.id, reference, price]
    );

    // Call EasyAccess API
    const response = await axios.post(
      `${BASE_URL}/data.php`,
      {
        network,
        mobileno: mobile_no,
        dataplan,
        client_reference: reference,
        max_amount_payable: price,
        webhook_url: "https://polexvtu-backend-production.up.railway.app/buydata/webhook"
      },
      { headers: { AuthorizationToken: API_TOKEN } }
    );

    // Update transaction with actual API amount if returned
    if (response.data && response.data.amount) {
      await db.query("UPDATE transactions SET api_amount = ? WHERE reference = ?", [response.data.amount, reference]);
    }

    return res.json({ success: true, message: "Purchase initiated", data: response.data, reference });
  } catch (error) {
    console.error("Buy data error:", error.message);
    return res.status(500).json({ success: false, message: "Error purchasing data", error: error.message });
  }
});

/**
 * POST /buydata/webhook
 * EasyAccess sends transaction updates here.
 */
router.post("/webhook", async (req, res) => {
  const payload = req.body;

  try {
    await db.query("INSERT INTO webhook_logs (payload) VALUES (?)", [JSON.stringify(payload)]);

    const { client_reference, status, amount: apiAmount } = payload;
    if (!client_reference) return res.status(400).json({ success: false, message: "No client_reference" });

    const [transactions] = await db.query("SELECT * FROM transactions WHERE reference = ?", [client_reference]);
    if (!transactions.length) return res.status(404).json({ success: false, message: "Transaction not found" });

    const transaction = transactions[0];

    // Update actual API amount if provided
    if (apiAmount) {
      await db.query("UPDATE transactions SET api_amount = ? WHERE id = ?", [apiAmount, transaction.id]);
    }

    if (status === "success") {
      await db.query("UPDATE transactions SET status = 'success' WHERE id = ?", [transaction.id]);
    } else if (status === "failed") {
      await db.query("UPDATE transactions SET status = 'failed' WHERE id = ?", [transaction.id]);
      
      // Refund user the original amount they paid, not the API amount
      await db.query("UPDATE users SET balance = balance + ? WHERE id = ?", [transaction.amount, transaction.user_id]);
    }

    res.json({ success: true, message: "Webhook processed" });
  } catch (error) {
    console.error("Webhook error:", error.message);
    res.status(500).json({ success: false, message: "Error processing webhook", error: error.message });
  }
});

/**
 * GET /buydata/admin
 * Admin route to view transactions + dashboard stats + per-user totals
 */
router.get("/admin", async (req, res) => {
  try {
    let { status, page, limit, start_date, end_date, user_id, email } = req.query;
    page = parseInt(page) || 1;
    limit = parseInt(limit) || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
    }

    if (start_date && end_date) {
      conditions.push("t.created_at BETWEEN ? AND ?");
      params.push(start_date, end_date);
    } else if (start_date) {
      conditions.push("t.created_at >= ?");
      params.push(start_date);
    } else if (end_date) {
      conditions.push("t.created_at <= ?");
      params.push(end_date);
    }

    if (user_id) {
      conditions.push("u.id = ?");
      params.push(user_id);
    }
    if (email) {
      conditions.push("u.email = ?");
      params.push(email);
    }

    let query = `
      SELECT t.*, u.first_name, u.last_name, u.email 
      FROM transactions t 
      JOIN users u ON t.user_id = u.id
    `;
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY t.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    const [transactions] = await db.query(query, params);

    let countQuery = `
      SELECT COUNT(*) as total
      FROM transactions t
      JOIN users u ON t.user_id = u.id
    `;
    const countParams = [];
    if (conditions.length) {
      countQuery += " WHERE " + conditions.join(" AND ");
      countParams.push(...params.slice(0, -2));
    }
    const [countResult] = await db.query(countQuery, countParams);
    const total = countResult[0].total;

    let statsQuery = `
      SELECT 
        SUM(CASE WHEN status='success' THEN amount ELSE 0 END) as totalRevenue,
        SUM(CASE WHEN status='pending' THEN amount ELSE 0 END) as totalPending,
        SUM(CASE WHEN status='failed' THEN amount ELSE 0 END) as totalFailed
      FROM transactions t
      JOIN users u ON t.user_id = u.id
    `;
    const statsParams = [];
    if (conditions.length) {
      statsQuery += " WHERE " + conditions.join(" AND ");
      statsParams.push(...params.slice(0, -2));
    }
    const [stats] = await db.query(statsQuery, statsParams);

    let userTotalsQuery = `
      SELECT 
        u.id AS user_id,
        u.first_name,
        u.last_name,
        u.email,
        SUM(CASE WHEN t.status='success' THEN t.amount ELSE 0 END) AS totalSpent,
        COUNT(t.id) AS totalTransactions
      FROM users u
      LEFT JOIN transactions t ON u.id = t.user_id
    `;
    const userTotalsParams = [];
    if (user_id || email) {
      const userConditions = [];
      if (user_id) userConditions.push("u.id = ?");
      if (email) userConditions.push("u.email = ?");
      userTotalsQuery += " WHERE " + userConditions.join(" AND ");
      if (user_id) userTotalsParams.push(user_id);
      if (email) userTotalsParams.push(email);
    }
    userTotalsQuery += " GROUP BY u.id ORDER BY totalSpent DESC";
    const [userTotals] = await db.query(userTotalsQuery, userTotalsParams);

    res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      dashboard: stats[0],
      transactions,
      userTotals,
    });
  } catch (error) {
    console.error("Admin transactions error:", error.message);
    res.status(500).json({ success: false, message: "Error fetching transactions", error: error.message });
  }
});

module.exports = router;
