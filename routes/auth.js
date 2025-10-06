const express = require("express");
const router = express.Router();
const db = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// --------------------
// REGISTER
// --------------------
router.post("/register", async (req, res) => {
  const { firstName, lastName, email, phone, gender, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ message: "All required fields must be filled" });
  }

  try {
    // Check existing user (optional but recommended)
    const [existing] = await db.execute("SELECT id FROM users WHERE email = ? OR phone = ?", [email, phone]);
    if (existing.length > 0) {
      return res.status(400).json({ message: "Email or phone already in use" });
    }

    const hashed = await bcrypt.hash(password, 10);

    const [result] = await db.execute(
      "INSERT INTO users (first_name, last_name, email, phone, gender, password) VALUES (?, ?, ?, ?, ?, ?)",
      [firstName, lastName, email, phone, gender, hashed]
    );

    const token = jwt.sign(
      { id: result.insertId, email },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ token, message: "Registration successful" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// --------------------
// LOGIN
// --------------------
router.post("/login", async (req, res) => {
  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const [users] = await db.execute(
      "SELECT * FROM users WHERE email = ? OR phone = ?",
      [identifier, identifier]
    );

    if (!users || users.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, firstName: user.first_name },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      token,
      message: "Login successful",
      firstName: user.first_name,
      email: user.email,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
