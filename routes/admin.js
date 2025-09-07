const express = require("express");
const router = express.Router();
const db = require("../config/db"); // MySQL connection/pool

// ------------------------
// USERS MANAGEMENT
// ------------------------

// Get all users
router.get("/users", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM users ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update user balance / reward / role with validation
router.patch("/users/:id", async (req, res) => {
  const { balance, reward, role } = req.body;

  // Validation
  if (balance < 0 || reward < 0) {
    return res.status(400).json({ error: "Balance and reward cannot be negative" });
  }

  const validRoles = ["user", "admin"];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  try {
    await db.query(
      "UPDATE users SET balance=?, reward=?, role=? WHERE id=?",
      [balance, reward, role, req.params.id]
    );

    res.json({ message: "User updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------
// TRANSACTIONS MANAGEMENT
// ------------------------

// Get all transactions with user info
router.get("/transactions", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT t.id, t.reference, t.type, t.amount, t.status, t.created_at,
             u.first_name, u.last_name, u.email
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Approve or reject transaction and adjust user balance automatically
router.patch("/transactions/:id", async (req, res) => {
  const { status } = req.body; // 'success' or 'failed'

  if (!["success", "failed"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    // Get transaction
    const [transactions] = await db.query(
      "SELECT * FROM transactions WHERE id=?",
      [req.params.id]
    );
    if (!transactions.length) return res.status(404).json({ error: "Transaction not found" });

    const transaction = transactions[0];

    // Only update if status is changing
    if (transaction.status !== status) {
      await db.query("UPDATE transactions SET status=? WHERE id=?", [status, req.params.id]);

      // Adjust user balance if approved
      if (status === "success") {
        if (transaction.type === "withdraw") {
          await db.query(
            "UPDATE users SET balance = balance - ? WHERE id=?",
            [transaction.amount, transaction.user_id]
          );
        } else if (transaction.type === "fund") {
          await db.query(
            "UPDATE users SET balance = balance + ? WHERE id=?",
            [transaction.amount, transaction.user_id]
          );
        }
      }
    }

    res.json({ message: "Transaction updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------
// ANALYTICS ENDPOINTS
// ------------------------

// Top users by income
router.get("/top-users", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT CONCAT(u.first_name, ' ', u.last_name) AS name, SUM(t.amount) AS total
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.status = 'success'
      GROUP BY t.user_id
      ORDER BY total DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Income per day/week/month
router.get("/income", async (req, res) => {
  try {
    const range = req.query.range || "day";
    let groupBy;
    if (range === "day") groupBy = "DATE(created_at)";
    else if (range === "week") groupBy = "YEARWEEK(created_at)";
    else groupBy = "MONTH(created_at)";

    const [rows] = await db.query(`
      SELECT ${groupBy} AS period, SUM(amount) AS total
      FROM transactions
      WHERE status='success'
      GROUP BY period
      ORDER BY period ASC
    `);

    const data = {
      labels: rows.map((r) => r.period),
      totals: rows.map((r) => r.total),
    };

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
