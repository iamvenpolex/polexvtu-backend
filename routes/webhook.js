"use strict";

const express = require("express");
const crypto = require("crypto");

const router = express.Router();
const db = require("../config/db");

// =====================================================
// STATUS HELPERS
// =====================================================

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase();
}

function isSuccess(status) {
  return [
    "success",
    "successful",
    "completed",
  ].includes(normalizeStatus(status));
}

function isFailed(status) {
  return [
    "failed",
    "failure",
    "cancelled",
    "canceled",
  ].includes(normalizeStatus(status));
}

// =====================================================
// EASYACCESS WEBHOOK
// POST /api/webhook/easyaccess
// =====================================================

router.post("/easyaccess", async (req, res) => {
  // Respond immediately to EasyAccess
  res.status(200).json({
    received: true,
  });

  try {
    console.log("==========================================");
    console.log("📬 EASYACCESS WEBHOOK RECEIVED");
    console.log("==========================================");

    console.log(
      "BODY:",
      JSON.stringify(req.body, null, 2)
    );

    const {
      status,
      message,
      client_reference,
      reference,
      transaction_date,
    } = req.body;

    const clientReference =
      client_reference || null;

    const providerReference =
      reference || null;

    // =================================================
    // CHECK REFERENCE
    // =================================================

    if (
      !clientReference &&
      !providerReference
    ) {
      console.warn(
        "⚠️ EasyAccess webhook has no reference"
      );

      return;
    }

    // =================================================
    // FIND TRANSACTION
    // =================================================

    const rows = await db`
      SELECT
        id,
        user_id,
        reference,
        provider_reference,
        api_reference,
        status,
        amount,
        refunded,
        balance_before,
        balance_after
      FROM transactions
      WHERE
        reference = ${clientReference || ""}
        OR provider_reference = ${
          providerReference || ""
        }
        OR api_reference = ${
          clientReference || ""
        }
      LIMIT 1
    `;

    if (!rows.length) {
      console.warn(
        "⚠️ EasyAccess transaction not found:",
        clientReference ||
          providerReference
      );

      return;
    }

    const transaction = rows[0];

    const apiResponse = {
      source: "easyaccess_webhook",
      status,
      message,
      client_reference:
        clientReference,
      reference:
        providerReference,
      transaction_date,
    };

    // =================================================
    // SUCCESS
    // =================================================

    if (isSuccess(status)) {
      await db`
        UPDATE transactions
        SET
          status = 'success',

          provider_reference =
            COALESCE(
              ${providerReference},
              provider_reference
            ),

          api_reference =
            COALESCE(
              ${clientReference},
              api_reference
            ),

          provider_status =
            ${status},

          api_response =
            ${JSON.stringify(apiResponse)},

          updated_at = NOW()

        WHERE id = ${transaction.id}

        AND status NOT IN (
          'success',
          'failed'
        )
      `;

      console.log(
        `✅ EasyAccess SUCCESS: ${transaction.reference}`
      );

      return;
    }

    // =================================================
    // FAILED + REFUND
    // =================================================

    if (isFailed(status)) {
      await db.begin(async (tx) => {
        const locked = await tx`
          SELECT
            t.id,
            t.user_id,
            t.amount,
            t.status,
            t.refunded,
            t.balance_before,
            t.balance_after,
            u.balance

          FROM transactions t

          JOIN users u
            ON u.id = t.user_id

          WHERE t.id = ${transaction.id}

          FOR UPDATE OF t, u
        `;

        if (!locked.length) {
          return;
        }

        const current =
          locked[0];

        // =================================================
        // ALREADY RESOLVED
        // =================================================

        if (
          current.refunded === true ||
          current.status === "failed"
        ) {
          console.log(
            `ℹ️ EasyAccess already resolved: ${transaction.reference}`
          );

          return;
        }

        const amount =
          Number(current.amount);

        const currentBalance =
          Number(current.balance || 0);

        const newBalance =
          currentBalance + amount;

        // =================================================
        // REFUND USER
        // =================================================

        await tx`
          UPDATE users
          SET
            balance =
              balance + ${amount}

          WHERE id =
            ${current.user_id}
        `;

        // =================================================
        // UPDATE TRANSACTION
        // =================================================

        await tx`
          UPDATE transactions
          SET

            status = 'failed',

            refunded = TRUE,

            provider_reference =
              COALESCE(
                ${providerReference},
                provider_reference
              ),

            api_reference =
              COALESCE(
                ${clientReference},
                api_reference
              ),

            provider_status =
              ${status},

            balance_before =
              ${currentBalance},

            balance_after =
              ${newBalance},

            description =
              'EasyAccess transaction failed - wallet refunded',

            api_response =
              ${JSON.stringify(apiResponse)},

            updated_at = NOW()

          WHERE id =
            ${current.id}
        `;

        console.log(
          `💰 EasyAccess REFUND ₦${amount.toFixed(
            2
          )} → user ${current.user_id}`
        );
      });

      return;
    }

    // =================================================
    // UNKNOWN STATUS
    // =================================================

    console.warn(
      `⚠️ Unknown EasyAccess status: ${status}`
    );
  } catch (err) {
    console.error(
      "❌ EasyAccess webhook error:",
      err.message
    );
  }
});

// =====================================================
// PAYMENTPOINT WEBHOOK
// POST /api/webhook/paymentpoint
// =====================================================

router.post(
  "/paymentpoint",
  async (req, res) => {
    try {
      console.log("==========================================");
      console.log("📬 PAYMENTPOINT WEBHOOK RECEIVED");
      console.log("==========================================");

      console.log(
        "BODY:",
        JSON.stringify(req.body, null, 2)
      );

      // =================================================
      // SECRET KEY
      // =================================================

      const secretKey =
        process.env.PAYMENTPOINT_SECRET_KEY;

      if (!secretKey) {
        console.error(
          "❌ PAYMENTPOINT_SECRET_KEY is not configured"
        );

        return res.status(500).json({
          success: false,
          message:
            "PaymentPoint webhook configuration missing",
        });
      }

      // =================================================
      // GET SIGNATURE
      // =================================================

      const receivedSignature =
        String(
          req.headers[
            "paymentpoint-signature"
          ] ||
            req.headers[
              "Paymentpoint-Signature"
            ] ||
            ""
        ).trim();

      if (!receivedSignature) {
        console.error(
          "❌ PaymentPoint signature header missing"
        );

        return res.status(401).json({
          success: false,
          message:
            "Missing signature",
        });
      }

      // =================================================
      // RAW BODY
      // =================================================

      if (!req.rawBody) {
        console.error(
          "❌ req.rawBody is missing"
        );

        return res.status(400).json({
          success: false,
          message:
            "Raw request body unavailable",
        });
      }

      // =================================================
      // GENERATE SIGNATURE
      //
      // PaymentPoint signs the RAW JSON body.
      // =================================================

      const expectedSignature =
        crypto
          .createHmac(
            "sha256",
            secretKey
          )
          .update(req.rawBody)
          .digest("hex");

      console.log(
        "🔐 Received signature:",
        receivedSignature
      );

      console.log(
        "🔐 Expected signature:",
        expectedSignature
      );

      // =================================================
      // VERIFY SIGNATURE
      // =================================================

      let signatureIsValid = false;

      if (
        expectedSignature.length ===
        receivedSignature.length
      ) {
        signatureIsValid =
          crypto.timingSafeEqual(
            Buffer.from(
              expectedSignature,
              "utf8"
            ),
            Buffer.from(
              receivedSignature,
              "utf8"
            )
          );
      }

      if (!signatureIsValid) {
        console.error(
          "❌ INVALID PAYMENTPOINT SIGNATURE"
        );

        return res.status(401).json({
          success: false,
          message:
            "Invalid signature",
        });
      }

      console.log(
        "✅ PaymentPoint signature verified"
      );

      // =================================================
      // EXTRACT WEBHOOK DATA
      // =================================================

      const {
        notification_status,
        transaction_id,
        amount_paid,
        settlement_amount,
        settlement_fee,
        transaction_status,
        sender,
        receiver,
        customer,
        description,
        timestamp,
      } = req.body;

      // =================================================
      // TRANSACTION ID
      // =================================================

      if (!transaction_id) {
        console.error(
          "❌ Missing transaction_id"
        );

        return res.status(400).json({
          success: false,
          message:
            "Missing transaction_id",
        });
      }

      // =================================================
      // ONLY PROCESS SUCCESSFUL TRANSACTIONS
      // =================================================

      if (
        !isSuccess(
          transaction_status
        )
      ) {
        console.log(
          `ℹ️ PaymentPoint transaction status: ${transaction_status}`
        );

        return res.status(200).json({
          success: true,
          received: true,
          message:
            "Payment not successful",
        });
      }

      // =================================================
      // AMOUNTS
      // =================================================

      const amountPaid =
        Number(amount_paid || 0);

      const settlementAmount =
        Number(
          settlement_amount || 0
        );

      const settlementFee =
        Number(
          settlement_fee || 0
        );

      // =================================================
      // VALIDATE AMOUNT PAID
      // =================================================

      if (
        !Number.isFinite(
          amountPaid
        ) ||
        amountPaid <= 0
      ) {
        console.error(
          "❌ Invalid amount_paid:",
          amount_paid
        );

        return res.status(400).json({
          success: false,
          message:
            "Invalid amount paid",
        });
      }

      // =================================================
      // VALIDATE SETTLEMENT
      // =================================================

      if (
        !Number.isFinite(
          settlementAmount
        ) ||
        settlementAmount <= 0
      ) {
        console.error(
          "❌ Invalid settlement_amount:",
          settlement_amount
        );

        return res.status(400).json({
          success: false,
          message:
            "Invalid settlement amount",
        });
      }

      // =================================================
      // ACCOUNT NUMBER
      // =================================================

      const accountNumber =
        receiver?.account_number
          ? String(
              receiver.account_number
            ).trim()
          : null;

      // =================================================
      // CUSTOMER ID
      // =================================================

      const customerId =
        customer?.customer_id
          ? String(
              customer.customer_id
            ).trim()
          : null;

      console.log(
        "🏦 Receiver account:",
        accountNumber
      );

      console.log(
        "👤 Customer ID:",
        customerId
      );

      console.log(
        "💵 Amount paid:",
        amountPaid
      );

      console.log(
        "💸 Settlement amount:",
        settlementAmount
      );

      console.log(
        "💰 PaymentPoint fee:",
        settlementFee
      );

      // =================================================
      // FIND USER
      // =================================================

      let userRows = [];

      // =================================================
      // PRIMARY:
      // ACCOUNT NUMBER
      // =================================================

      if (accountNumber) {
        userRows = await db`
          SELECT
            u.id AS user_id,
            u.balance,
            va.id AS virtual_account_id,
            va.account_number,
            va.customer_id

          FROM virtual_accounts va

          INNER JOIN users u
            ON u.id = va.user_id

          WHERE va.account_number =
            ${accountNumber}

          LIMIT 1
        `;

        console.log(
          "🔎 Account lookup:",
          userRows
        );
      }

      // =================================================
      // FALLBACK:
      // CUSTOMER ID
      // =================================================

      if (
        !userRows.length &&
        customerId
      ) {
        userRows = await db`
          SELECT
            u.id AS user_id,
            u.balance,
            va.id AS virtual_account_id,
            va.account_number,
            va.customer_id

          FROM virtual_accounts va

          INNER JOIN users u
            ON u.id = va.user_id

          WHERE va.customer_id =
            ${customerId}

          LIMIT 1
        `;

        console.log(
          "🔎 Customer lookup:",
          userRows
        );
      }

      // =================================================
      // USER NOT FOUND
      // =================================================

      if (!userRows.length) {
        console.error(
          "❌ NO USER FOUND FOR PAYMENT"
        );

        console.error({
          accountNumber,
          customerId,
          transaction_id,
        });

        return res.status(200).json({
          success: false,
          received: true,
          message:
            "Virtual account not found",
        });
      }

      const userId =
        userRows[0].user_id;

      console.log(
        `✅ USER FOUND: ${userId}`
      );

      // =================================================
      // CREDIT AMOUNT
      //
      // IMPORTANT:
      //
      // amountPaid = what customer paid
      //
      // settlementAmount = what PaymentPoint
      // receives after its fee.
      //
      // This version credits the FULL amountPaid
      // to the user's TapAm wallet.
      //
      // Example:
      //
      // Customer pays: ₦100
      // PaymentPoint fee: ₦0.50
      // Settlement: ₦99.50
      // User wallet: ₦100.00
      //
      // TapAm absorbs ₦0.50.
      // =================================================

      const creditAmount =
        amountPaid;

      // =================================================
      // DATABASE TRANSACTION
      // =================================================

      await db.begin(async (tx) => {
        // =================================================
        // DUPLICATE PROTECTION
        // =================================================

        const existing =
          await tx`
            SELECT
              id,
              user_id,
              amount,
              status

            FROM transactions

            WHERE provider_reference =
              ${transaction_id}

            LIMIT 1
          `;

        if (existing.length) {
          console.log(
            "ℹ️ PAYMENT ALREADY PROCESSED:",
            transaction_id
          );

          return;
        }

        // =================================================
        // LOCK USER
        // =================================================

        const lockedUser =
          await tx`
            SELECT
              id,
              balance

            FROM users

            WHERE id =
              ${userId}

            FOR UPDATE
          `;

        if (!lockedUser.length) {
          throw new Error(
            `User ${userId} does not exist`
          );
        }

        // =================================================
        // BALANCE BEFORE
        // =================================================

        const balanceBefore =
          Number(
            lockedUser[0]
              .balance || 0
          );

        // =================================================
        // BALANCE AFTER
        // =================================================

        const balanceAfter =
          balanceBefore +
          creditAmount;

        console.log(
          `💳 Balance before: ₦${balanceBefore.toFixed(
            2
          )}`
        );

        console.log(
          `💰 Credit amount: ₦${creditAmount.toFixed(
            2
          )}`
        );

        console.log(
          `💳 Balance after: ₦${balanceAfter.toFixed(
            2
          )}`
        );

        // =================================================
        // CREDIT USER WALLET
        // =================================================

        const updateResult =
          await tx`
            UPDATE users

            SET
              balance =
                balance +
                ${creditAmount}

            WHERE id =
              ${userId}

            RETURNING
              id,
              balance
          `;

        if (!updateResult.length) {
          throw new Error(
            "Failed to update user wallet"
          );
        }

        console.log(
          "✅ USER WALLET CREDITED"
        );

        console.log(
          "💰 NEW DATABASE BALANCE:",
          updateResult[0].balance
        );

        // =================================================
        // CREATE TRANSACTION
        // =================================================

        const transaction =
          await tx`
            INSERT INTO transactions (
              user_id,
              reference,
              type,
              amount,
              status,
              via,
              description,
              balance_before,
              balance_after,
              provider_reference,
              provider_status,
              amount_paid,
              settlement_fee,
              settlement_amount,
              refunded,
              api_response,
              created_at,
              updated_at
            )

            VALUES (
              ${userId},

              ${`PP-${transaction_id}`},

              'deposit',

              ${creditAmount},

              'success',

              'paymentpoint',

              'Wallet funded via PaymentPoint',

              ${balanceBefore},

              ${balanceAfter},

              ${transaction_id},

              ${transaction_status},

              ${amountPaid},

              ${settlementFee},

              ${settlementAmount},

              FALSE,

              ${JSON.stringify({
                source:
                  "paymentpoint_webhook",

                notification_status,

                transaction_id,

                amount_paid:
                  amountPaid,

                settlement_amount:
                  settlementAmount,

                settlement_fee:
                  settlementFee,

                transaction_status,

                sender,

                receiver,

                customer,

                description,

                timestamp,
              })},

              NOW(),

              NOW()
            )

            RETURNING
              id,
              user_id,
              reference,
              type,
              amount,
              status,
              via,
              balance_before,
              balance_after,
              provider_reference,
              amount_paid,
              settlement_fee,
              settlement_amount,
              created_at
          `;

        if (!transaction.length) {
          throw new Error(
            "Transaction history was not created"
          );
        }

        console.log(
          "✅ TRANSACTION CREATED:"
        );

        console.log(
          transaction[0]
        );
      });

      // =================================================
      // SUCCESS
      // =================================================

      console.log(
        "=========================================="
      );

      console.log(
        "🎉 PAYMENTPOINT PAYMENT SUCCESSFUL"
      );

      console.log(
        `👤 User ID: ${userId}`
      );

      console.log(
        `💵 Amount paid: ₦${amountPaid.toFixed(
          2
        )}`
      );

      console.log(
        `💸 PaymentPoint fee: ₦${settlementFee.toFixed(
          2
        )}`
      );

      console.log(
        `💰 Settlement: ₦${settlementAmount.toFixed(
          2
        )}`
      );

      console.log(
        `💰 User credited: ₦${creditAmount.toFixed(
          2
        )}`
      );

      console.log(
        `🔖 PaymentPoint ID: ${transaction_id}`
      );

      console.log(
        "=========================================="
      );

      return res.status(200).json({
        success: true,
        received: true,
        message:
          "Payment processed successfully",
      });
    } catch (error) {
      console.error(
        "=========================================="
      );

      console.error(
        "❌ PAYMENTPOINT WEBHOOK ERROR"
      );

      console.error(
        error
      );

      console.error(
        error?.stack
      );

      console.error(
        "=========================================="
      );

      return res.status(500).json({
        success: false,
        message:
          "Webhook processing failed",
      });
    }
  }
);

// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;

