const express = require("express");
const router = express.Router();
const cors = require("cors");
const db = require("../config/db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const adminAuth = require("../middleware/adminAuth");

// ------------------------
// CORS
// ------------------------
router.use(
  cors({
    origin: ["http://localhost:3000", "https://tapam.mipitech.com.ng"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ------------------------
// TEST ROUTE
// ------------------------
router.get("/login", (req, res) => {
  res.send("Admin route active. Use POST /login to authenticate.");
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
    console.error("Admin login error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------------------------------------
// USERS MANAGEMENT
// --------------------------------------------------
router.get("/users", adminAuth, async (req, res) => {
  try {
    const users = await db`
      SELECT id, first_name, last_name, email, phone, balance, reward, role, created_at, deleted
      FROM users
      ORDER BY created_at DESC
    `;
    res.json(users);
  } catch (err) {
    console.error("Fetch users error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------------------------------------
// UPDATE USER (ADMIN CAN UPDATE ANY FIELD)
// --------------------------------------------------
router.patch("/users/:id", adminAuth, async (req, res) => {
  const allowedFields = [
    "first_name",
    "last_name",
    "email",
    "phone",
    "balance",
    "reward",
    "role",
  ];

  const updates = {};

  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  if (updates.balance !== undefined && updates.balance < 0)
    return res.status(400).json({ error: "Balance cannot be negative" });

  if (updates.reward !== undefined && updates.reward < 0)
    return res.status(400).json({ error: "Reward cannot be negative" });

  if (updates.role && !["user", "admin"].includes(updates.role))
    return res.status(400).json({ error: "Invalid role" });

  try {
    await db`
      UPDATE users SET ${db(updates)} WHERE id = ${req.params.id}
    `;

    res.json({ message: "User updated successfully" });
  } catch (err) {
    console.error("Update user error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------------------------------------
// SOFT DELETE USER (TEMPORARY DELETE)
// --------------------------------------------------
router.delete("/users/:id", adminAuth, async (req, res) => {
  const userId = req.params.id;

  try {
    await db`
      UPDATE users
      SET 
        deleted = TRUE,
        first_name = 'Deleted',
        last_name = 'User',
        email = ${"deleted_" + userId + "@removed.com"},
        phone = '00000000000',
        balance = 0,
        reward = 0,
        password = ${bcrypt.hashSync("DELETED" + Date.now(), 10)}
      WHERE id = ${userId}
    `;

    await db`
      UPDATE transactions SET status = 'failed'
      WHERE user_id = ${userId}
    `;

    res.json({ message: "User temporarily deleted & masked successfully" });
  } catch (err) {
    console.error("Delete user error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------------------------------------
// RESTORE USER
// --------------------------------------------------
router.patch("/users/:id/restore", adminAuth, async (req, res) => {
  const userId = req.params.id;

  try {
    await db`
      UPDATE users SET deleted = FALSE
      WHERE id = ${userId}
    `;

    res.json({ message: "User restored successfully" });
  } catch (err) {
    console.error("Restore user error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------------------------------------
// TRANSACTIONS LIST
// --------------------------------------------------
router.get("/transactions", adminAuth, async (req, res) => {
  try {
    const rows = await db`
      SELECT t.*, 
             u.first_name, u.last_name, u.email
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `;

    res.json(rows);
  } catch (err) {
    console.error("Fetch transactions error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------------------------------------
// UPDATE TRANSACTION — (❌ NO BALANCE UPDATE ❌)
// --------------------------------------------------
router.patch("/transactions/:id", adminAuth, async (req, res) => {
  const { status } = req.body;

  if (!["success", "failed"].includes(status))
    return res.status(400).json({ error: "Invalid status" });

  try {
    const trx = await db`
      SELECT * FROM transactions WHERE id = ${req.params.id}
    `;

    if (!trx.length)
      return res.status(404).json({ error: "Transaction not found" });

    // ONLY UPDATE TRANSACTION STATUS
    await db`
      UPDATE transactions
      SET status = ${status}
      WHERE id = ${req.params.id}
    `;

    res.json({ message: "Transaction updated (no balance change)" });
  } catch (err) {
    console.error("Update transaction error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------------------------------------
// ANALYTICS
// --------------------------------------------------
router.get("/analytics/overview", adminAuth, async (req, res) => {
  try {
    const totalUsers = await db`SELECT COUNT(*) FROM users`;
    const totalTransactions = await db`SELECT COUNT(*) FROM transactions`;
    const totalSuccessful = await db`
      SELECT COALESCE(SUM(amount),0) AS total
      FROM transactions
      WHERE status = 'success'
    `;

    res.json({
      users: totalUsers[0].count,
      transactions: totalTransactions[0].count,
      revenue: Number(totalSuccessful[0].total),
    });
  } catch (err) {
    console.error("Overview analytics error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Income grouping
router.get("/income", adminAuth, async (req, res) => {
  try {
    const range = req.query.range || "day";

    const rows = await db`
      SELECT created_at, amount
      FROM transactions
      WHERE status = 'success'
    `;

    let grouped = {};

    rows.forEach((r) => {
      const date = new Date(r.created_at);
      let key;

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
    console.error("Income analytics error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
