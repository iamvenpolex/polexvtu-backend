const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.id) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      message: "Invalid or expired token",
    });
  }
}

// GET user's virtual account
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

    res.json({
      hasAccount: true,
      account: rows[0],
    });
  } catch (err) {
    console.error("❌ Virtual account fetch error:", err);

    res.status(500).json({
      message: "Failed to fetch virtual account",
    });
  }
});

// CREATE user's virtual account
router.post("/create", authMiddleware, async (req, res) => {
  try {
    const userRows = await db`
      SELECT id, first_name, last_name, email, phone
      FROM users
      WHERE id = ${req.user.id}
    `;

    if (!userRows.length) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const user = userRows[0];

    // Check if account already exists
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
        account: existing[0],
      });
    }

    const name = `${user.first_name} ${user.last_name}`.trim();

    const response = await axios.post(
      `${process.env.PAYMENTPOINT_API_URL}/api/v1/createVirtualAccount`,
      {
        email: user.email,
        name,
        phoneNumber: user.phone,

        // PaymentPoint supports these according
        // to the documentation you provided.
        bankCode: ["20946", "20897"],

        businessId: process.env.PAYMENTPOINT_BUSINESS_ID,

        // Only send these if you actually collect them.
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

    if (data.status !== "success") {
      return res.status(400).json({
        message: data.message || "Failed to create virtual account",
        errors: data.errors || [],
      });
    }

    const account = data.bankAccounts?.[0];

    if (!account) {
      return res.status(400).json({
        message: "PaymentPoint did not return a bank account",
      });
    }

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

    res.json({
      message: "Virtual account created successfully",
      account: {
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        bankName: account.bankName,
        bankCode: account.bankCode,
        reservedAccountId: account.Reserved_Account_Id,
      },
    });
  } catch (err) {
    console.error(
      "❌ PaymentPoint error:",
      err.response?.data || err.message
    );

    res.status(500).json({
      message:
        err.response?.data?.message ||
        "Unable to create virtual account",
    });
  }
});

module.exports = router;