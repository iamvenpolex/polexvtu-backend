const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

// ==========================================
// JWT AUTH MIDDLEWARE
// ==========================================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "No token provided",
    });
  }

  try {
    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (!decoded.id) {
      return res.status(401).json({
        message: "Invalid token payload",
      });
    }

    req.user = decoded;

    next();
  } catch (err) {
    console.error("❌ JWT error:", err.message);

    return res.status(401).json({
      message: "Invalid or expired token",
    });
  }
}

// ==========================================
// GET USER'S VIRTUAL ACCOUNT
// GET /api/virtual-account
// ==========================================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const rows = await db`
      SELECT
        customer_id,
        account_number,
        account_name,
        bank_name,
        bank_code,
        reserved_account_id
      FROM virtual_accounts
      WHERE user_id = ${req.user.id}
    `;

    if (rows.length === 0) {
      return res.json({
        hasAccount: false,
        account: null,
      });
    }

    return res.json({
      hasAccount: true,
      account: rows[0],
    });
  } catch (err) {
    console.error(
      "❌ Virtual account fetch error:",
      err.message
    );

    return res.status(500).json({
      message: "Failed to fetch virtual account",
    });
  }
});

// ==========================================
// CREATE USER'S VIRTUAL ACCOUNT
// POST /api/virtual-account/create
// ==========================================
router.post("/create", authMiddleware, async (req, res) => {
  try {
    // ------------------------------------------
    // Get logged-in user
    // ------------------------------------------
    const userRows = await db`
      SELECT
        id,
        first_name,
        last_name,
        email,
        phone
      FROM users
      WHERE id = ${req.user.id}
    `;

    if (userRows.length === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const user = userRows[0];

    // ------------------------------------------
    // Check if user already has an account
    // ------------------------------------------
    const existing = await db`
      SELECT
        customer_id,
        account_number,
        account_name,
        bank_name,
        bank_code,
        reserved_account_id
      FROM virtual_accounts
      WHERE user_id = ${user.id}
    `;

    if (existing.length > 0) {
      return res.json({
        message: "Virtual account already exists",
        hasAccount: true,
        account: existing[0],
      });
    }

    // ------------------------------------------
    // User's full name
    // ------------------------------------------
    const name = `${user.first_name} ${user.last_name}`.trim();

    // ------------------------------------------
    // Create account with PaymentPoint
    // ------------------------------------------
    const response = await axios.post(
      `${process.env.PAYMENTPOINT_API_URL}/api/v1/createVirtualAccount`,
      {
        email: user.email,
        name: name,
        phoneNumber: user.phone,

        // PalmPay + OPay
        bankCode: ["20946", "20897"],

        businessId: process.env.PAYMENTPOINT_BUSINESS_ID,

        // BVN/NIN can be supplied from the frontend
        // if PaymentPoint requires it.
        ...(req.body.idType && req.body.idNumber
          ? {
              idType: req.body.idType,
              idNumber: req.body.idNumber,
            }
          : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYMENTPOINT_API_SECRET}`,
          "api-key": process.env.PAYMENTPOINT_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const data = response.data;

    console.log(
      "📬 PaymentPoint response:",
      data
    );

    // ------------------------------------------
    // Check PaymentPoint response
    // ------------------------------------------
    if (data.status !== "success") {
      return res.status(400).json({
        message:
          data.message ||
          "Failed to create virtual account",
        errors: data.errors || [],
      });
    }

    // ------------------------------------------
    // Get first bank account
    // ------------------------------------------
    const account = data.bankAccounts?.[0];

    if (!account) {
      return res.status(400).json({
        message:
          "PaymentPoint did not return a bank account",
      });
    }

    // ------------------------------------------
    // Save account in PostgreSQL
    // ------------------------------------------
    await db`
      INSERT INTO virtual_accounts (
        user_id,
        customer_id,
        account_number,
        account_name,
        bank_name,
        bank_code,
        reserved_account_id
      )
      VALUES (
        ${user.id},
        ${data.customer?.customer_id || null},
        ${account.accountNumber},
        ${account.accountName},
        ${account.bankName},
        ${account.bankCode},
        ${account.Reserved_Account_Id || null}
      )
    `;

    console.log(
      `✅ Virtual account created for user ${user.id}`
    );

    // ------------------------------------------
    // Send account back to frontend
    // ------------------------------------------
    return res.status(201).json({
      message: "Virtual account created successfully",
      hasAccount: true,
      account: {
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        bankName: account.bankName,
        bankCode: account.bankCode,
        reservedAccountId:
          account.Reserved_Account_Id || null,
      },
    });
  } catch (err) {
    console.error(
      "❌ PaymentPoint error:",
      err.response?.data || err.message
    );

    return res.status(500).json({
      message:
        err.response?.data?.message ||
        "Unable to create virtual account",
    });
  }
});

module.exports = router;

