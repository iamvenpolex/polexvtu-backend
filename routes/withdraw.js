const express = require("express");
const router = express.Router();
const db = require("../config/db");
const jwt = require("jsonwebtoken");

// ------------------------
// Middleware: Protect Routes
// ------------------------
const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Not authorized" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Not authorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token invalid or expired" });
  }
};

// ------------------------
// REWARD → WALLET
// ------------------------
router.post("/reward-to-wallet", protect, async (req, res) => {
  const { amount } = req.body;
  const userId = req.user.id;

  if (!amount || amount <= 0)
    return res.status(400).json({ error: "Invalid amount" });

  try {
    const [rows] = await db.execute(
      "SELECT first_name, last_name, email, reward, balance FROM users WHERE id=?",
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });

    const user = rows[0];
    if (user.reward < amount)
      return res.status(400).json({ error: "Insufficient reward balance" });

    // 🔖 Create reference
    const reference = `REWARD${Date.now()}`;

    // 💰 Update reward and wallet balances
    await db.execute(
      "UPDATE users SET reward = reward - ?, balance = balance + ? WHERE id=?",
      [amount, amount, userId]
    );

   

    // 🧾 Log into tapam_accounts (sender = receiver = same user)
    await db.execute(
      `INSERT INTO tapam_accounts 
        (sender_id, sender_name, sender_email, receiver_id, receiver_name, receiver_email, amount, reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        `${user.first_name} ${user.last_name}`,
        user.email,
        userId,
        `${user.first_name} ${user.last_name}`,
        user.email,
        amount,
        reference,
        "success",
      ]
    );

    res.json({
      message: `✅ Successfully moved ₦${amount.toLocaleString()} from reward to wallet.`,
      reference,
    });
  } catch (err) {
    console.error("❌ Reward → Wallet Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------
// WALLET → TAPAM BY EMAIL
// ------------------------
router.post("/wallet-to-tapam", protect, async (req, res) => {
  let { amount, email, recipientName } = req.body;
  const userId = req.user.id;

  if (!amount || amount <= 0)
    return res.status(400).json({ error: "Invalid amount" });
  if (!email || !recipientName)
    return res
      .status(400)
      .json({ error: "Email and recipient name are required" });

  email = email.trim().toLowerCase();
  recipientName = recipientName.trim();

  try {
    const [recipientRows] = await db.execute(
      "SELECT id, first_name, last_name, email FROM users WHERE email = ? AND id != ?",
      [email, userId]
    );

    if (!recipientRows.length)
      return res.status(404).json({ error: "Recipient not found" });

    const recipient = recipientRows[0];
    const fullName = `${recipient.first_name} ${recipient.last_name}`;

    const normalize = (str) => str.toLowerCase().trim().replace(/\s+/g, " ");
    if (normalize(fullName) !== normalize(recipientName)) {
      return res
        .status(400)
        .json({ error: "Recipient name does not match our records." });
    }

    const [userRows] = await db.execute(
      "SELECT first_name, last_name, email, balance FROM users WHERE id=?",
      [userId]
    );
    if (!userRows.length) return res.status(404).json({ error: "User not found" });

    const user = userRows[0];
    if (user.balance < amount)
      return res.status(400).json({ error: "Insufficient wallet balance" });

    const reference = `TAPAM${Date.now()}`;

    await db.execute("UPDATE users SET balance = balance - ? WHERE id=?", [
      amount,
      userId,
    ]);
    await db.execute("UPDATE users SET balance = balance + ? WHERE id=?", [
      amount,
      recipient.id,
    ]);

   

    await db.execute(
      `INSERT INTO tapam_accounts 
        (sender_id, sender_name, sender_email, receiver_id, receiver_name, receiver_email, amount, reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        `${user.first_name} ${user.last_name}`,
        user.email,
        recipient.id,
        fullName,
        recipient.email,
        amount,
        reference,
        "success",
      ]
    );

    res.json({
      message: `✅ Successfully sent ₦${amount.toLocaleString()} to ${fullName}`,
      recipient: fullName,
      reference,
    });
  } catch (err) {
    console.error("❌ Wallet → Tapam Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------
// LOOKUP TAPAM BY EMAIL
// ------------------------
router.get("/tapam/lookup", protect, async (req, res) => {
  const { email } = req.query;
  if (!email)
    return res.status(400).json({ error: "Email is required for lookup" });

  try {
    const [rows] = await db.execute(
      "SELECT first_name, last_name FROM users WHERE email = ?",
      [email.trim().toLowerCase()]
    );

    if (!rows.length)
      return res.status(404).json({ error: "Recipient not found" });

    const fullName = `${rows[0].first_name} ${rows[0].last_name}`;
    res.json({ name: fullName });
  } catch (err) {
    console.error("❌ Lookup Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
