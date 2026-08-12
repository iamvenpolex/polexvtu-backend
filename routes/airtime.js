"use strict";

require("dotenv").config();

const express = require("express");
const router = express.Router();
const axios = require("axios");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const API_KEY = process.env.API_247_KEY;
const BASE_URL = "https://247api.com.ng/api";

const CASHBACK_RATE = 0.01;

const MIN_AIRTIME = 100;
const MAX_AIRTIME = 50000;

// =====================================================
// NETWORKS
// 247API PROVIDER IDS
// =====================================================

const NETWORKS = {
  "1": {
    id: 1,
    name: "MTN",
    prefixes: [
      "0703",
      "0706",
      "0803",
      "0806",
      "0810",
      "0813",
      "0814",
      "0816",
      "0903",
      "0906",
      "0913",
      "0916",
    ],
  },

  "2": {
    id: 2,
    name: "Airtel",
    prefixes: [
      "0802",
      "0808",
      "0708",
      "0812",
      "0701",
      "0901",
      "0907",
      "0912",
    ],
  },

  "3": {
    id: 3,
    name: "Glo",
    prefixes: [
      "0805",
      "0807",
      "0705",
      "0815",
      "0811",
      "0905",
      "0915",
    ],
  },

  "4": {
    id: 4,
    name: "9mobile",
    prefixes: [
      "0809",
      "0818",
      "0817",
      "0908",
      "0909",
      "0918",
    ],
  },
};

// =====================================================
// AUTH
// =====================================================

const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      message: "Not authorized",
    });
  }

  const parts = authHeader.split(" ");

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({
      success: false,
      message: "Invalid authorization format",
    });
  }

  const token = parts[1];

  try {
    req.user = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Token invalid or expired. Log in again",
    });
  }
};

// =====================================================
// STATUS NORMALIZER
// =====================================================

function mapTransactionStatus(apiResponse) {
  const status = String(
    apiResponse?.status || ""
  ).toLowerCase();

  const secondaryStatus = String(
    apiResponse?.Status || ""
  ).toLowerCase();

  const responseText = String(
    apiResponse?.response ||
      apiResponse?.api_response ||
      ""
  ).toLowerCase();

  // SUCCESS
  if (
    status === "success" ||
    status === "successful" ||
    secondaryStatus === "success" ||
    secondaryStatus === "successful"
  ) {
    return "success";
  }

  // PENDING
  if (
    status === "pending" ||
    secondaryStatus === "pending"
  ) {
    return "pending";
  }

  // FAILED
  if (
    status === "failed" ||
    status === "fail" ||
    status === "failure" ||
    secondaryStatus === "failed" ||
    secondaryStatus === "fail" ||
    secondaryStatus === "failure"
  ) {
    return "failed";
  }

  // Provider sometimes returns success in text
  if (
    responseText.includes("transaction successful") ||
    responseText.includes("purchase successful") ||
    responseText.includes("successful")
  ) {
    return "success";
  }

  // Unknown responses should NOT be treated as success
  return "failed";
}

// =====================================================
// INTERNAL REFERENCE
// =====================================================

function generateReference() {
  return `AIRTIME_${Date.now()}_${Math.floor(
    Math.random() * 1000000
  )}`;
}

function generateCashbackReference(reference) {
  return `CASHBACK_${reference}`;
}

// =====================================================
// VALIDATE NETWORK + PHONE
// =====================================================

function validateNetworkAndPhone(network, phone) {
  const networkKey = String(network);

  const selectedNetwork = NETWORKS[networkKey];

  if (!selectedNetwork) {
    return {
      valid: false,
      message: "Invalid network selected",
    };
  }

  if (!/^\d{11}$/.test(phone)) {
    return {
      valid: false,
      message: "Phone number must be 11 digits",
    };
  }

  const prefix = phone.substring(0, 4);

  if (!selectedNetwork.prefixes.includes(prefix)) {
    return {
      valid: false,
      message: `The phone number does not belong to ${selectedNetwork.name}`,
    };
  }

  return {
    valid: true,
    network: selectedNetwork,
  };
}

// =====================================================
// BUY AIRTIME
// POST /api/airtime/buy
// =====================================================

router.post(
  "/buy",
  protect,
  async (req, res) => {
    let reference = null;

    try {
      const {
        network,
        amount,
        phone,
        bypass = false,
        plan_type = "VTU",
      } = req.body;

      // =================================================
      // VALIDATION
      // =================================================

      if (
        network === undefined ||
        network === null ||
        amount === undefined ||
        amount === null ||
        !phone
      ) {
        return res.status(400).json({
          success: false,
          message:
            "network, amount and phone are required",
        });
      }

      const numericAmount = Number(amount);

      if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid airtime amount",
        });
      }

      if (numericAmount < MIN_AIRTIME) {
        return res.status(400).json({
          success: false,
          message: `Minimum airtime amount is ₦${MIN_AIRTIME.toLocaleString()}`,
        });
      }

      if (numericAmount > MAX_AIRTIME) {
        return res.status(400).json({
          success: false,
          message: `Maximum airtime amount is ₦${MAX_AIRTIME.toLocaleString()}`,
        });
      }

      // Make sure phone is treated as string
      const normalizedPhone = String(phone).trim();

      // =================================================
      // NETWORK + PHONE VALIDATION
      // =================================================

      const validation =
        validateNetworkAndPhone(
          network,
          normalizedPhone
        );

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: validation.message,
        });
      }

      const selectedNetwork =
        validation.network;

      // =================================================
      // CHECK API KEY
      // =================================================

      if (!API_KEY) {
        console.error(
          "API_247_KEY is missing from environment variables"
        );

        return res.status(500).json({
          success: false,
          message:
            "Airtime provider configuration error",
        });
      }

      // =================================================
      // GET USER
      // =================================================

      const users = await db`
        SELECT id, balance
        FROM users
        WHERE id = ${req.user.id}
        LIMIT 1
      `;

      const user = users[0];

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      const balanceBefore =
        Number(user.balance);

      if (
        !Number.isFinite(balanceBefore)
      ) {
        return res.status(500).json({
          success: false,
          message:
            "Invalid wallet balance",
        });
      }

      if (
        balanceBefore < numericAmount
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Insufficient wallet balance",
        });
      }

      // =================================================
      // CASHBACK
      // =================================================

      const cashback = Math.floor(
        numericAmount * CASHBACK_RATE
      );

      const balanceAfterPurchase =
        balanceBefore - numericAmount;

      const balanceAfterCashback =
        balanceAfterPurchase + cashback;

      // =================================================
      // GENERATE INTERNAL REFERENCE
      // =================================================

      reference = generateReference();

      // =================================================
      // DEDUCT WALLET + CREATE PENDING TRANSACTION
      // =================================================

      await db.begin(async (sql) => {
        // Re-check balance inside transaction
        const lockedUsers = await sql`
          SELECT id, balance
          FROM users
          WHERE id = ${req.user.id}
          FOR UPDATE
        `;

        const lockedUser =
          lockedUsers[0];

        if (!lockedUser) {
          throw new Error(
            "User not found"
          );
        }

        const currentBalance =
          Number(lockedUser.balance);

        if (
          currentBalance <
          numericAmount
        ) {
          throw new Error(
            "INSUFFICIENT_BALANCE"
          );
        }

        const newBalance =
          currentBalance -
          numericAmount;

        // Update wallet
        await sql`
          UPDATE users
          SET balance = ${newBalance}
          WHERE id = ${req.user.id}
        `;

        // Create pending transaction
        await sql`
          INSERT INTO transactions (
            user_id,
            reference,
            provider_reference,
            type,
            amount,
            status,
            refunded,
            created_at,
            api_amount,
            network,
            phone,
            via,
            description,
            balance_before,
            balance_after
          )
          VALUES (
            ${req.user.id},
            ${reference},
            NULL,
            'airtime',
            ${numericAmount},
            'pending',
            false,
            NOW(),
            ${numericAmount},
            ${selectedNetwork.id},
            ${normalizedPhone},
            'wallet',
            ${`Airtime purchase for ${normalizedPhone}`},
            ${currentBalance},
            ${newBalance}
          )
        `;
      });

      // =================================================
      // CALL 247API
      // =================================================

      let apiResponse;

      try {
        apiResponse = await axios.post(
          `${BASE_URL}/airtime`,
          {
            network:
              selectedNetwork.id,

            phone: normalizedPhone,

            amount:
              String(numericAmount),

            bypass,

            "request-id":
              reference,

            plan_type,
          },
          {
            headers: {
              Authorization:
                `Token ${API_KEY}`,

              "Content-Type":
                "application/json",
            },

            timeout: 30000,
          }
        );
      } catch (apiError) {
        console.error(
          "247API AIRTIME ERROR:",
          apiError.response?.data ||
            apiError.message
        );

        // =============================================
        // PROVIDER REQUEST FAILED
        // REFUND USER
        // =============================================

        await db.begin(async (sql) => {
          const pending =
            await sql`
              SELECT
                balance_before,
                status,
                refunded
              FROM transactions
              WHERE reference = ${reference}
                AND user_id = ${req.user.id}
              LIMIT 1
            `;

          const transaction =
            pending[0];

          // Only refund if still pending
          if (
            transaction &&
            transaction.status ===
              "pending" &&
            transaction.refunded ===
              false
          ) {
            const refundBalance =
              Number(
                transaction.balance_before
              );

            await sql`
              UPDATE users
              SET balance = ${refundBalance}
              WHERE id = ${req.user.id}
            `;

            await sql`
              UPDATE transactions
              SET
                status = 'failed',
                refunded = true,
                api_response = ${JSON.stringify(
                  apiError.response
                    ?.data || {
                    error:
                      apiError.message,
                  }
                )},
                balance_after = ${refundBalance},
                updated_at = NOW()
              WHERE reference = ${reference}
                AND user_id = ${req.user.id}
                AND status = 'pending'
            `;
          }
        });

        return res.status(500).json({
          success: false,
          status: "failed",
          message:
            "Provider unavailable. Wallet refunded.",
          reference,
          cashback: 0,
        });
      }

      // =================================================
      // PROVIDER RESPONSE
      // =================================================

      const raw =
        apiResponse?.data || {};

      console.log(
        "247API AIRTIME RESPONSE:",
        raw
      );

      // =================================================
      // PROVIDER REFERENCE
      // =================================================

      const providerReference =
        raw?.["request-id"] ||
        raw?.request_id ||
        null;

      // =================================================
      // DETERMINE STATUS
      // =================================================

      const finalStatus =
        mapTransactionStatus(raw);

      console.log(
        "AIRTIME STATUS:",
        finalStatus
      );

      console.log(
        "AIRTIME PROVIDER REFERENCE:",
        providerReference
      );

      // =================================================
      // SUCCESS
      // =================================================

      if (
        finalStatus === "success"
      ) {
        const cashbackReference =
          generateCashbackReference(
            reference
          );

        await db.begin(async (sql) => {
          // -------------------------------------------
          // Get current transaction
          // -------------------------------------------

          const existing =
            await sql`
              SELECT
                id,
                status,
                refunded
              FROM transactions
              WHERE reference = ${reference}
                AND user_id = ${req.user.id}
              LIMIT 1
              FOR UPDATE
            `;

          const transaction =
            existing[0];

          if (!transaction) {
            throw new Error(
              "Airtime transaction not found"
            );
          }

          // -------------------------------------------
          // Only complete a pending transaction
          // -------------------------------------------

          if (
            transaction.status !==
            "pending"
          ) {
            return;
          }

          // -------------------------------------------
          // UPDATE MAIN AIRTIME TRANSACTION
          //
          // IMPORTANT:
          // provider_reference is stored here only.
          // -------------------------------------------

          await sql`
            UPDATE transactions
            SET
              status = 'success',
              provider_reference = ${providerReference},
              api_amount = ${
                raw?.amount ??
                numericAmount
              },
              api_response = ${JSON.stringify({
                ...raw,
                cashback_applied:
                  cashback,
              })},
              balance_after = ${balanceAfterCashback},
              updated_at = NOW()
            WHERE reference = ${reference}
              AND user_id = ${req.user.id}
              AND status = 'pending'
          `;

          // -------------------------------------------
          // CREDIT CASHBACK
          // -------------------------------------------

          if (cashback > 0) {
            await sql`
              UPDATE users
              SET balance = ${balanceAfterCashback}
              WHERE id = ${req.user.id}
            `;

            // -----------------------------------------
            // CREATE CASHBACK TRANSACTION
            //
            // NO ON CONFLICT HERE.
            //
            // We use WHERE NOT EXISTS because your
            // reference column does not have a unique
            // constraint.
            //
            // provider_reference is NULL because the
            // cashback is NOT a provider transaction.
            // -----------------------------------------

            await sql`
              INSERT INTO transactions (
                user_id,
                reference,
                provider_reference,
                type,
                amount,
                status,
                refunded,
                created_at,
                api_amount,
                network,
                phone,
                via,
                description,
                balance_before,
                balance_after
              )
              SELECT
                ${req.user.id},
                ${cashbackReference},
                NULL,
                'cashback',
                ${cashback},
                'success',
                false,
                NOW(),
                ${cashback},
                ${selectedNetwork.id},
                ${normalizedPhone},
                'cashback',
                ${`1% cashback on airtime for ${normalizedPhone}`},
                ${balanceAfterPurchase},
                ${balanceAfterCashback}
              WHERE NOT EXISTS (
                SELECT 1
                FROM transactions
                WHERE reference = ${cashbackReference}
              )
            `;
          }
        });

        return res.json({
          success: true,
          status: "success",

          message:
            raw?.message ||
            "Airtime purchase successful",

          reference,

          provider_reference:
            providerReference,

          transaction_status:
            "success",

          amount:
            numericAmount,

          cashback,

          api_response: raw,
        });
      }

      // =================================================
      // PENDING
      // =================================================

      if (
        finalStatus === "pending"
      ) {
        await db`
          UPDATE transactions
          SET
            status = 'pending',
            provider_reference = ${providerReference},
            api_amount = ${
              raw?.amount ??
              numericAmount
            },
            api_response = ${JSON.stringify(
              raw
            )},
            updated_at = NOW()
          WHERE reference = ${reference}
            AND user_id = ${req.user.id}
            AND status = 'pending'
        `;

        return res.json({
          success: true,
          status: "pending",

          message:
            raw?.message ||
            "Transaction is being processed",

          reference,

          provider_reference:
            providerReference,

          transaction_status:
            "pending",

          amount:
            numericAmount,

          cashback: 0,

          api_response: raw,
        });
      }

      // =================================================
      // FAILED
      // =================================================

      await db.begin(async (sql) => {
        const pending =
          await sql`
            SELECT
              balance_before,
              status,
              refunded
            FROM transactions
            WHERE reference = ${reference}
              AND user_id = ${req.user.id}
            LIMIT 1
            FOR UPDATE
          `;

        const transaction =
          pending[0];

        if (
          transaction &&
          transaction.status ===
            "pending" &&
          transaction.refunded ===
            false
        ) {
          const refundBalance =
            Number(
              transaction.balance_before
            );

          // Refund wallet
          await sql`
            UPDATE users
            SET balance = ${refundBalance}
            WHERE id = ${req.user.id}
          `;

          // Mark transaction failed
          await sql`
            UPDATE transactions
            SET
              status = 'failed',
              refunded = true,
              provider_reference = ${providerReference},
              api_amount = ${
                raw?.amount ?? 0
              },
              api_response = ${JSON.stringify(
                raw
              )},
              balance_after = ${refundBalance},
              updated_at = NOW()
            WHERE reference = ${reference}
              AND user_id = ${req.user.id}
              AND status = 'pending'
          `;
        }
      });

      return res.status(400).json({
        success: false,
        status: "failed",

        message:
          raw?.message ||
          "Airtime purchase failed. Wallet refunded.",

        reference,

        provider_reference:
          providerReference,

        transaction_status:
          "failed",

        amount:
          numericAmount,

        cashback: 0,

        api_response: raw,
      });
    } catch (error) {
      console.error(
        "BUY AIRTIME ERROR:",
        error
      );

      // =================================================
      // SAFETY REFUND
      //
      // If something unexpected happens after wallet
      // deduction, refund ONLY if the transaction is
      // still pending and has not already been refunded.
      // =================================================

      if (reference) {
        try {
          await db.begin(async (sql) => {
            const transactions =
              await sql`
                SELECT
                  user_id,
                  balance_before,
                  amount,
                  status,
                  refunded
                FROM transactions
                WHERE reference = ${reference}
                  AND user_id = ${req.user.id}
                LIMIT 1
                FOR UPDATE
              `;

            const transaction =
              transactions[0];

            if (
              transaction &&
              transaction.status ===
                "pending" &&
              transaction.refunded ===
                false
            ) {
              const refundBalance =
                Number(
                  transaction.balance_before
                );

              // Refund wallet
              await sql`
                UPDATE users
                SET balance = ${refundBalance}
                WHERE id = ${req.user.id}
              `;

              // Mark transaction failed
              await sql`
                UPDATE transactions
                SET
                  status = 'failed',
                  refunded = true,
                  balance_after = ${refundBalance},
                  api_response = ${JSON.stringify(
                    {
                      error:
                        "Internal error after wallet deduction",
                    }
                  )},
                  updated_at = NOW()
                WHERE reference = ${reference}
                  AND user_id = ${req.user.id}
                  AND status = 'pending'
              `;
            }
          });
        } catch (refundError) {
          console.error(
            "AIRTIME SAFETY REFUND ERROR:",
            refundError
          );
        }
      }

      // Handle insufficient balance
      if (
        error?.message ===
        "INSUFFICIENT_BALANCE"
      ) {
        return res.status(400).json({
          success: false,
          status: "failed",
          message:
            "Insufficient wallet balance",
          reference,
        });
      }

      return res.status(500).json({
        success: false,
        status: "failed",
        message:
          "Internal server error",
        reference,
      });
    }
  }
);

// =====================================================
// BENEFICIARIES
// GET /api/airtime/beneficiaries
// =====================================================

router.get(
  "/beneficiaries",
  protect,
  async (req, res) => {
    try {
      const rows = await db`
        SELECT
          phone,
          MAX(created_at) AS last_used
        FROM transactions
        WHERE user_id = ${req.user.id}
          AND status = 'success'
          AND type = 'airtime'
          AND phone IS NOT NULL
          AND phone != ''
        GROUP BY phone
        ORDER BY last_used DESC
        LIMIT 6
      `;

      return res.json({
        success: true,
        phones: rows.map(
          (row) => row.phone
        ),
      });
    } catch (error) {
      console.error(
        "BENEFICIARIES ERROR:",
        error.message
      );

      return res.status(500).json({
        success: false,
        phones: [],
      });
    }
  }
);

// =====================================================
// NETWORKS
// GET /api/airtime/networks
// =====================================================

router.get(
  "/networks",
  protect,
  async (req, res) => {
    try {
      const response =
        await axios.get(
          `${BASE_URL}/get-networks?service=airtime`,
          {
            headers: {
              Authorization:
                `Token ${API_KEY}`,

              "Content-Type":
                "application/json",
            },

            timeout: 30000,
          }
        );

      return res.json({
        success: true,
        data: response.data,
      });
    } catch (error) {
      console.error(
        "GET NETWORKS ERROR:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch networks",
      });
    }
  }
);

module.exports = router;