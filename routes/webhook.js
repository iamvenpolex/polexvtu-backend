
"use strict";

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../config/db");

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isSuccess(status) {
  return ["success", "successful", "completed"].includes(
    normalizeStatus(status)
  );
}

function isFailed(status) {
  return ["failed", "failure", "cancelled", "canceled"].includes(
    normalizeStatus(status)
  );
}

// =====================================================
// EASYACCESS WEBHOOK
// POST /api/webhook/easyaccess
// =====================================================

router.post("/easyaccess", async (req, res) => {
  // Respond immediately
  res.status(200).json({ received: true });

  try {
    console.log("📬 EasyAccess Webhook:", req.body);

    const {
      status,
      message,
      client_reference,
      reference,
      transaction_date,
    } = req.body;

    const clientReference = client_reference || null;
    const providerReference = reference || null;

    if (!clientReference && !providerReference) {
      console.warn("⚠️ EasyAccess webhook has no reference");
      return;
    }

    // Find transaction using our reference,
    // provider reference or API reference.
    const rows = await db`
      SELECT
        id,
        user_id,
        reference,
        provider_reference,
        api_reference,
        status,
        amount,
        refunded
      FROM transactions
      WHERE
        reference = ${clientReference || ""}
        OR provider_reference = ${providerReference || ""}
        OR api_reference = ${clientReference || ""}
      LIMIT 1
    `;

    if (!rows.length) {
      console.warn(
        "⚠️ EasyAccess transaction not found:",
        clientReference || providerReference
      );
      return;
    }

    const transaction = rows[0];

    const apiResponse = {
      source: "easyaccess_webhook",
      status,
      message,
      client_reference: clientReference,
      reference: providerReference,
      transaction_date,
    };

    // -------------------------
    // SUCCESS
    // -------------------------
    if (isSuccess(status)) {
      await db`
        UPDATE transactions
        SET
          status = 'success',
          provider_reference = COALESCE(
            ${providerReference},
            provider_reference
          ),
          api_reference = COALESCE(
            ${clientReference},
            api_reference
          ),
          api_response = ${JSON.stringify(apiResponse)},
          updated_at = NOW()
        WHERE id = ${transaction.id}
          AND status NOT IN ('success', 'failed')
      `;

      console.log(
        `✅ EasyAccess SUCCESS: ${transaction.reference}`
      );

      return;
    }

    // -------------------------
    // FAILED + REFUND
    // -------------------------
    if (isFailed(status)) {
      await db.begin(async (tx) => {
        const locked = await tx`
          SELECT
            t.id,
            t.user_id,
            t.amount,
            t.status,
            t.refunded,
            u.balance
          FROM transactions t
          JOIN users u ON u.id = t.user_id
          WHERE t.id = ${transaction.id}
          FOR UPDATE OF t, u
        `;

        if (!locked.length) return;

        const current = locked[0];

        // Already refunded/resolved
        if (
          current.refunded === true ||
          current.status === "failed"
        ) {
          console.log(
            `ℹ️ EasyAccess already resolved: ${transaction.reference}`
          );
          return;
        }

        const amount = Number(current.amount);

        await tx`
          UPDATE users
          SET balance = balance + ${amount}
          WHERE id = ${current.user_id}
        `;

        const newBalance =
          Number(current.balance) + amount;

        await tx`
          UPDATE transactions
          SET
            status = 'failed',
            refunded = TRUE,
            provider_reference = COALESCE(
              ${providerReference},
              provider_reference
            ),
            api_reference = COALESCE(
              ${clientReference},
              api_reference
            ),
            balance_after = ${newBalance},
            api_response = ${JSON.stringify(apiResponse)},
            updated_at = NOW()
          WHERE id = ${current.id}
        `;

        console.log(
          `💰 EasyAccess REFUND ₦${amount} → user ${current.user_id}`
        );
      });

      return;
    }

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

router.post("/paymentpoint", async (req, res) => {
  try {
    console.log("📬 PaymentPoint Webhook:", req.body);

    const signature =
      req.headers["paymentpoint-signature"] ||
      req.headers["Paymentpoint-Signature"];

    /*
     * IMPORTANT:
     * PaymentPoint requires signature verification.
     *
     * Put your PaymentPoint secret/security key in:
     *
     * PAYMENTPOINT_SECRET_KEY
     */

    const secretKey = process.env.PAYMENTPOINT_SECRET_KEY;

    if (!secretKey) {
      console.error(
        "❌ PAYMENTPOINT_SECRET_KEY is not configured"
      );

      return res.status(500).json({
        message: "PaymentPoint webhook configuration missing",
      });
    }

    /*
     * Express must provide the raw request body
     * for proper HMAC verification.
     *
     * If your app uses express.json(), see the note
     * below this code.
     */

    if (!req.rawBody) {
      console.error(
        "❌ Raw PaymentPoint webhook body is unavailable"
      );

      return res.status(400).json({
        message: "Raw webhook body unavailable",
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", secretKey)
      .update(req.rawBody)
      .digest("hex");

    if (
      !signature ||
      !crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(String(signature))
      )
    ) {
      console.warn(
        "❌ Invalid PaymentPoint webhook signature"
      );

      return res.status(401).json({
        message: "Invalid signature",
      });
    }

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

    if (!transaction_id) {
      return res.status(400).json({
        message: "Missing transaction_id",
      });
    }

    /*
     * PaymentPoint's customer.customer_id should correspond
     * to the customer/user you created at PaymentPoint.
     *
     * We first try customer_id.
     */

    const customerId = customer?.customer_id || null;

    let rows = [];

    if (customerId) {
      rows = await db`
        SELECT
          t.id,
          t.user_id,
          t.reference,
          t.status,
          t.amount,
          t.refunded
        FROM transactions t
        JOIN virtual_accounts va
          ON va.user_id = t.user_id
        WHERE va.paymentpoint_customer_id = ${customerId}
        ORDER BY t.created_at DESC
        LIMIT 1
      `;
    }

    /*
     * If this is a deposit into a user's virtual account,
     * find the user using the receiver account number.
     */

    if (!rows.length && receiver?.account_number) {
      rows = await db`
        SELECT
          u.id AS user_id,
          va.id AS virtual_account_id,
          va.account_number
        FROM virtual_accounts va
        JOIN users u
          ON u.id = va.user_id
        WHERE va.account_number = ${receiver.account_number}
        LIMIT 1
      `;
    }

    /*
     * PaymentPoint deposit may not have an existing transaction.
     * In that case create one.
     */

    const paymentAmount = Number(
      settlement_amount || amount_paid || 0
    );

    if (paymentAmount <= 0) {
      return res.status(400).json({
        message: "Invalid payment amount",
      });
    }

    if (isSuccess(transaction_status)) {
      await db.begin(async (tx) => {
        /*
         * Prevent duplicate webhook processing.
         */
        const existing = await tx`
          SELECT id
          FROM transactions
          WHERE provider_reference = ${transaction_id}
          LIMIT 1
        `;

        if (existing.length) {
          console.log(
            `ℹ️ PaymentPoint transaction already processed: ${transaction_id}`
          );
          return;
        }

        /*
         * If we found the user's virtual account,
         * credit that user.
         */

        let userId = null;

        if (rows.length) {
          userId = rows[0].user_id;
        }

        if (!userId) {
          console.warn(
            `⚠️ PaymentPoint user not found for transaction: ${transaction_id}`
          );
          return;
        }

        const userRows = await tx`
          SELECT balance
          FROM users
          WHERE id = ${userId}
          FOR UPDATE
        `;

        if (!userRows.length) return;

        const currentBalance =
          Number(userRows[0].balance || 0);

        const newBalance =
          currentBalance + paymentAmount;

        /*
         * Credit user's wallet.
         */
        await tx`
          UPDATE users
          SET balance = balance + ${paymentAmount}
          WHERE id = ${userId}
        `;

        /*
         * Create transaction record.
         */
        await tx`
          INSERT INTO transactions (
            user_id,
            reference,
            provider_reference,
            amount,
            status,
            type,
            is_credit,
            balance_after,
            api_response,
            created_at,
            updated_at
          )
          VALUES (
            ${userId},
            ${`PP-${transaction_id}`},
            ${transaction_id},
            ${paymentAmount},
            'success',
            'deposit',
            TRUE,
            ${newBalance},
            ${JSON.stringify({
              source: "paymentpoint_webhook",
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
            })},
            NOW(),
            NOW()
          )
        `;

        console.log(
          `💰 PaymentPoint CREDIT ₦${paymentAmount} → user ${userId}`
        );
      });

      return res.status(200).json({
        received: true,
      });
    }

    console.log(
      `ℹ️ PaymentPoint transaction status: ${transaction_status}`
    );

    return res.status(200).json({
      received: true,
    });
  } catch (err) {
    console.error(
      "❌ PaymentPoint webhook error:",
      err.message
    );

    return res.status(500).json({
      message: "Webhook processing failed",
    });
  }
});

module.exports = router;
