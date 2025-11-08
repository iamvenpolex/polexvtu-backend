const express = require("express");
const router = express.Router();
const cors = require("cors");
const db = require("../config/db"); // postgres.js client
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
    const rows = await db`
      SELECT * FROM users WHERE email = ${email} AND role = 'admin'
    `;

    if (!rows.length) return res.status(404).json({ error: "Admin not found" });

    const admin = rows[0];
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
    const rows = await db`
      SELECT id, first_name, last_name, email, balance, reward, role, created_at
      FROM users
      ORDER BY created_at DESC
    `;
    res.json(rows);
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
    await db`
      UPDATE users
      SET balance = ${balance}, reward = ${reward}, role = ${role}
      WHERE id = ${req.params.id}
    `;
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
    const rows = await db`
      SELECT t.id, t.reference, t.type, t.amount, t.status, t.created_at,
             u.first_name, u.last_name, u.email
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `;
    res.json(rows);
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
    const transactions = await db`
      SELECT * FROM transactions WHERE id = ${req.params.id}
    `;

    if (!transactions.length)
      return res.status(404).json({ error: "Transaction not found" });

    const transaction = transactions[0];

    if (transaction.status !== status) {
      await db`
        UPDATE transactions SET status = ${status} WHERE id = ${req.params.id}
      `;

      if (status === "success") {
        if (transaction.type === "withdraw") {
          await db`
            UPDATE users SET balance = balance - ${transaction.amount} WHERE id = ${transaction.user_id}
          `;
        } else if (transaction.type === "fund") {
          await db`
            UPDATE users SET balance = balance + ${transaction.amount} WHERE id = ${transaction.user_id}
          `;
        }
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
    const rows = await db`
      SELECT CONCAT(u.first_name, ' ', u.last_name) AS name, SUM(t.amount) AS total
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.status = 'success'
      GROUP BY t.user_id
      ORDER BY total DESC
      LIMIT 10
    `;
    res.json(rows);
  } catch (err) {
    console.error("❌ Top users error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/income", adminAuth, async (req, res) => {
  try {
    const range = req.query.range || "day";

    const rows = await db`
      SELECT created_at, amount
      FROM transactions
      WHERE status = 'success'
    `;

    let grouped = {};

    rows.forEach(r => {
      let key;
      const date = new Date(r.created_at);
      if (range === "week") {
        const week = Math.ceil((date.getDate() - date.getDay() + 1) / 7);
        key = `${date.getFullYear()}-W${week}`;
      } else if (range === "month") {
        key = `${date.getFullYear()}-${date.getMonth() + 1}`;
      } else {
        key = date.toISOString().split("T")[0];
      }

      grouped[key] = (grouped[key] || 0) + Number(r.amount);
    });

    res.json({
      labels: Object.keys(grouped),
      totals: Object.values(grouped),
    });
  } catch (err) {
    console.error("❌ Income analytics error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
