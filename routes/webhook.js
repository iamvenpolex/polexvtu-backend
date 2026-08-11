"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/db");

function isSuccess(status) {
  return ["success", "successful"].includes(
    String(status || "").toLowerCase()
  );
}

function isFailed(status) {
  return String(status || "").toLowerCase() === "failed";
}

// ─────────────────────────────────────────────
// EASYACCESS WEBHOOK
// POST /api/webhook/easyaccess
// ─────────────────────────────────────────────

router.post(
  "/easyaccess",
  express.json(),
  async (req, res) => {
    // Respond immediately.
    // EasyAccess expects a response within 5 seconds.
    res.status(200).json({
      received: true,
    });

    const {
      status,
      message,
      client_reference,
      reference,
      transaction_date,
    } = req.body;

    console.log(
      "📬 EasyAccess Webhook:",
      req.body
    );

    if (!client_reference) {
      console.warn(
        "⚠️ Webhook missing client_reference"
      );
      return;
    }

    try {
      // ─────────────────────────────────────────
      // SUCCESS
      // ─────────────────────────────────────────

      if (isSuccess(status)) {
        await db.begin(async (tx) => {
          const rows = await tx`
            SELECT id, status
            FROM transactions
            WHERE reference = ${client_reference}
            FOR UPDATE
          `;

          if (!rows.length) {
            console.warn(
              "⚠️ Webhook transaction not found:",
              client_reference
            );
            return;
          }

          const transaction = rows[0];

          // Already resolved
          if (
            transaction.status === "success" ||
            transaction.status === "failed"
          ) {
            console.log(
              `ℹ️ ${client_reference} already resolved as ${transaction.status}`
            );
            return;
          }

          await tx`
            UPDATE transactions
            SET
              status = 'success',
              api_response = ${JSON.stringify({
                source: "webhook",
                status,
                message,
                reference,
                client_reference,
                transaction_date,
              })},
              updated_at = NOW()
            WHERE id = ${transaction.id}
          `;

          console.log(
            `✅ Webhook: ${client_reference} → SUCCESS`
          );
        });

        return;
      }

      // ─────────────────────────────────────────
      // FAILED
      // ─────────────────────────────────────────

      if (isFailed(status)) {
        await db.begin(async (tx) => {
          const rows = await tx`
            SELECT
              t.id,
              t.user_id,
              t.amount,
              t.status,
              u.balance AS current_balance
            FROM transactions t
            JOIN users u ON u.id = t.user_id
            WHERE t.reference = ${client_reference}
            FOR UPDATE
          `;

          if (!rows.length) {
            console.warn(
              "⚠️ Webhook transaction not found:",
              client_reference
            );
            return;
          }

          const transaction = rows[0];

          // Already resolved.
          // This is what prevents double refund.
          if (transaction.status === "success") {
            console.log(
              `⚠️ ${client_reference} is already SUCCESS. No refund.`
            );
            return;
          }

          if (transaction.status === "failed") {
            console.log(
              `ℹ️ ${client_reference} already refunded.`
            );
            return;
          }

          const refundAmount =
            Number(transaction.amount);

          const currentBalance =
            Number(transaction.current_balance);

          const balanceAfterRefund =
            currentBalance + refundAmount;

          // Refund current wallet balance
          await tx`
            UPDATE users
            SET balance = balance + ${refundAmount}
            WHERE id = ${transaction.user_id}
          `;

          // Mark transaction failed
          await tx`
            UPDATE transactions
            SET
              status = 'failed',
              balance_after = ${balanceAfterRefund},
              api_response = ${JSON.stringify({
                source: "webhook",
                status,
                message,
                reference,
                client_reference,
                transaction_date,
              })},
              updated_at = NOW()
            WHERE id = ${transaction.id}
          `;

          console.log(
            `💰 REFUNDED ₦${refundAmount} → user ${transaction.user_id}`
          );
        });

        return;
      }

      console.warn(
        `⚠️ Unrecognised webhook status "${status}" for ${client_reference}`
      );
    } catch (err) {
      console.error(
        "❌ Webhook processing error:",
        err.message
      );
    }
  }
);

module.exports = router;