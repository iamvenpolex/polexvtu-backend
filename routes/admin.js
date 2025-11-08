const express = require("express");
const router = express.Router();
const cors = require("cors");
const db = require("../config/db"); // Progress client
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const adminAuth = require("../middleware/adminAuth");

// ------------------------
// Enable CORS
// ------------------------
router.use(
  cors({
    origin: ["http://localhost:3000", "https://tapam.mipitech.com.ng"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ------------------------
// TEST ENDPOINT
// ------------------------
router.get("/login", (req, res) => {
  res.send("✅ Admin login endpoint is live. Use POST to login.");
});

// ------------------------
// ADMIN LOGIN
// ------------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const query = `SELECT * FROM users WHERE email = '${email}' AND role = 'admin'`;
    const result = await db.query(query);
    if (!result || result.length === 0)
      return res.status(404).json({ error: "Admin not found" });

    const admin = result[0];
    const validPassword = await bcrypt.compare(password, admin.password);
    if (!validPassword)
      return res.status(401).json({ error: "Invalid password" });

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ message: "Login successful", token });
  } catch (err) {
    console.error("❌ Admin login error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------
// USERS MANAGEMENT
// ------------------------
router.get("/users", adminAuth, async (req, res) => {
  try {
    const query = `SELECT id, first_name, last_name, email, balance, reward, role, created_at FROM users ORDER BY created_at DESC`;
    const users = await db.query(query);
    res.json(users);
  } catch (err) {
    console.error("❌ Fetch users error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/users/:id", adminAuth, async (req, res) => {
  const { balance, reward, role } = req.body;
  if (balance < 0 || reward < 0)
    return res.status(400).json({ error: "Balance and reward cannot be negative" });
  const validRoles = ["user", "admin"];
  if (role && !validRoles.includes(role))
    return res.status(400).json({ error: "Invalid role" });

  try {
    const query = `UPDATE users SET balance = ${balance}, reward = ${reward}, role = '${role}' WHERE id = ${req.params.id}`;
    await db.query(query);
    res.json({ message: "User updated successfully" });
  } catch (err) {
    console.error("❌ Update user error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------
// TRANSACTIONS MANAGEMENT
// ------------------------
router.get("/transactions", adminAuth, async (req, res) => {
  try {
    const query = `
      SELECT t.id, t.reference, t.type, t.amount, t.status, t.created_at,
             u.first_name, u.last_name, u.email
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `;
    const transactions = await db.query(query);
    res.json(transactions);
  } catch (err) {
    console.error("❌ Fetch transactions error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/transactions/:id", adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!["success", "failed"].includes(status))
    return res.status(400).json({ error: "Invalid status" });

  try {
    const transQuery = `SELECT * FROM transactions WHERE id = ${req.params.id}`;
    const transactions = await db.query(transQuery);
    if (!transactions || transactions.length === 0)
      return res.status(404).json({ error: "Transaction not found" });

    const transaction = transactions[0];
    if (transaction.status !== status) {
      const updateQuery = `UPDATE transactions SET status = '${status}' WHERE id = ${req.params.id}`;
      await db.query(updateQuery);

      // Update user balance
      if (status === "success") {
        let balanceQuery = "";
        if (transaction.type === "withdraw") {
          balanceQuery = `UPDATE users SET balance = balance - ${transaction.amount} WHERE id = ${transaction.user_id}`;
        } else if (transaction.type === "fund") {
          balanceQuery = `UPDATE users SET balance = balance + ${transaction.amount} WHERE id = ${transaction.user_id}`;
        }
        if (balanceQuery) await db.query(balanceQuery);
      }
    }

    res.json({ message: "Transaction updated successfully" });
  } catch (err) {
    console.error("❌ Update transaction error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------
// ANALYTICS
// ------------------------
router.get("/top-users", adminAuth, async (req, res) => {
  try {
    const query = `
      SELECT u.first_name || ' ' || u.last_name AS name, SUM(t.amount) AS total
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.status = 'success'
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY total DESC
      FETCH FIRST 10 ROWS ONLY
    `;
    const topUsers = await db.query(query);
    res.json(topUsers);
  } catch (err) {
    console.error("❌ Top users error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/income", adminAuth, async (req, res) => {
  try {
    const range = req.query.range || "day";
    let groupBy = "DATE(created_at)";
    if (range === "week") groupBy = "WEEK(created_at)"; // or adjust for Progress
    if (range === "month") groupBy = "MONTH(created_at)";

    const query = `
      SELECT ${groupBy} AS period, SUM(amount) AS total
      FROM transactions
      WHERE status = 'success'
      GROUP BY ${groupBy}
      ORDER BY ${groupBy} ASC
    `;
    const rows = await db.query(query);

    res.json({
      labels: rows.map((r) => r.period),
      totals: rows.map((r) => r.total),
    });
  } catch (err) {
    console.error("❌ Income analytics error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
