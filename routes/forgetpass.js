const express = require("express");
const router = express.Router();
const db = require("../config/db");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Send reset code
router.post("/request-reset", async (req, res) => {
  const { emailOrPhone } = req.body;

  if (!emailOrPhone) {
    return res.status(400).json({ success: false, message: "Email or phone is required" });
  }

  try {
    // Find user by email or phone
    const [rows] = await db.execute(
      "SELECT * FROM users WHERE email = ? OR phone = ?",
      [emailOrPhone, emailOrPhone]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }

    const user = rows[0];
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await db.execute(
      "UPDATE users SET reset_code = ?, reset_expires = ? WHERE id = ?",
      [code, expires, user.id]
    );

    // ✅ Send email using Resend shared sender
    const emailResponse = await resend.emails.send({
      from: "TapAm <onboarding@resend.dev>", // shared sender (no domain required)
      to: user.email,
      subject: "Password Reset Code",
      text: `Your password reset code is ${code}. It will expire in 10 minutes.`,
    });

    console.log("📧 Email sent:", emailResponse);

    res.json({ success: true, message: "Reset code sent successfully" });
  } catch (err) {
    console.error("Request reset error:", err);
    res.status(500).json({ success: false, message: "Failed to send reset code" });
  }
});

// ✅ Verify code
router.post("/verify-code", async (req, res) => {
  const { emailOrPhone, code } = req.body;

  if (!emailOrPhone || !code) {
    return res.status(400).json({ success: false, message: "All fields required" });
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM users WHERE (email = ? OR phone = ?) AND reset_code = ?",
      [emailOrPhone, emailOrPhone, code]
    );

    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid code" });
    }

    const user = rows[0];
    if (new Date(user.reset_expires) < new Date()) {
      return res.status(400).json({ success: false, message: "Code expired" });
    }

    res.json({ success: true, message: "Code verified successfully" });
  } catch (err) {
    console.error("Verify code error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Reset password
router.post("/reset-password", async (req, res) => {
  const { emailOrPhone, code, newPassword } = req.body;

  if (!emailOrPhone || !code || !newPassword) {
    return res.status(400).json({ success: false, message: "All fields are required" });
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM users WHERE (email = ? OR phone = ?) AND reset_code = ?",
      [emailOrPhone, emailOrPhone, code]
    );

    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid code" });
    }

    const user = rows[0];

    if (new Date(user.reset_expires) < new Date()) {
      return res.status(400).json({ success: false, message: "Code expired" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.execute(
      "UPDATE users SET password = ?, reset_code = NULL, reset_expires = NULL WHERE id = ?",
      [hashed, user.id]
    );

    res.json({ success: true, message: "Password reset successful" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
