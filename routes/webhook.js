"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/db");

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isSuccess(status) {
  return ["success", "successful"].includes(
    normalizeStatus(status)
  );
}

function isFailed(status) {
  return normalizeStatus(status) === "failed";
}

// ─────────────────────────────────────────────
// EASYACCESS WEBHOOK
// POST /api/webhook/easyaccess
// ─────────────────────────────────────────────

router.post(
  "/easyaccess",
  express.json(),
  async (req, res) => {
    // Respond immediately so EasyAccess does not retry unnecessarily.
    res.status(200).json({ received: true });

    const {
      status,
      message,
      client_reference,
      reference,
      transaction_date,
      amount,
    } = req.body;

    console.log("📬 EasyAccess Webhook:", req.body);

    if (!client_reference && !reference) {
      console.warn(
        "⚠️ Webhook missing client_reference/reference"
      );
      return;
    }

    try {
      let txRows;

      if (client_reference) {
        txRows = await db`
          SELECT
            t.id,
            t.user_id,
            t.reference,
            t.provider_reference,
            t.type,
            t.status,
            t.amount,
            t.refunded,
            t.balance_before
          FROM transactions t
          WHERE t.reference = ${client_reference}
          LIMIT 1
        `;
      } else {
        txRows = await db`
          SELECT
            t.id,
            t.user_id,
            t.reference,
            t.provider_reference,
            t.type,
            t.status,
            t.amount,
            t.refunded,
            t.balance_before
          FROM transactions t
          WHERE t.provider_reference = ${reference}
          LIMIT 1
        `;
      }

      if (!txRows.length) {
        console.warn(
          `⚠️ Webhook transaction not found: ${
            client_reference || reference
          }`
        );
        return;
      }

      const transaction = txRows[0];

      // Always save provider reference.
      if (reference) {
        await db`
          UPDATE transactions
          SET
            provider_reference = ${reference},
            api_amount = ${Number(amount || 0)},
            updated_at = NOW()
          WHERE id = ${transaction.id}
        `;
      }

      // Already resolved.
      if (
        transaction.status === "success" ||
        transaction.status === "failed" ||
        transaction.refunded === true
      ) {
        console.log(
          `ℹ️ Webhook ${transaction.reference} already resolved`
        );
        return;
      }

      const webhookLog = {
        source: "webhook",
        status,
        message,
        reference,
        client_reference,
        amount,
        transaction_date,
      };

      // ─────────────────────────────────────────────
      // SUCCESS
      // ─────────────────────────────────────────────

      if (isSuccess(status)) {
        await db`
          UPDATE transactions
          SET
            status = 'success',
            refunded = false,
            api_amount = ${Number(amount || 0)},
            api_response = ${JSON.stringify(webhookLog)},
            updated_at = NOW()
          WHERE id = ${transaction.id}
            AND status = 'pending'
            AND refunded = false
        `;

        console.log(
          `✅ Webhook: ${transaction.reference} → SUCCESS`
        );

        return;
      }

      // ─────────────────────────────────────────────
      // FAILED
      // ─────────────────────────────────────────────

      if (isFailed(status)) {
        await db.begin(async (tx) => {
          const lockedRows = await tx`
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

          if (!lockedRows.length) {
            return;
          }

          const locked = lockedRows[0];

          // Another process already refunded it.
          if (
            locked.status !== "pending" ||
            locked.refunded === true
          ) {
            return;
          }

          const refundAmount = Number(locked.amount);
          const newBalance =
            Number(locked.balance) + refundAmount;

          await tx`
            UPDATE users
            SET balance = balance + ${refundAmount}
            WHERE id = ${locked.user_id}
          `;

          await tx`
            UPDATE transactions
            SET
              status = 'failed',
              refunded = true,
              balance_after = ${newBalance},
              api_amount = ${Number(amount || 0)},
              api_response = ${JSON.stringify({
                ...webhookLog,
                refund: {
                  refunded: true,
                  amount: refundAmount,
                  source: "webhook",
                },
              })},
              updated_at = NOW()
            WHERE id = ${locked.id}
              AND status = 'pending'
              AND refunded = false
          `;
        });

        console.log(
          `❌ Webhook: ${transaction.reference} → FAILED/REFUNDED`
        );

        return;
      }

      console.warn(
        `⚠️ Webhook unknown status "${status}" for ${transaction.reference}`
      );
    } catch (err) {
      console.error(
        "❌ EasyAccess webhook processing error:",
        err
      );
    }
  }
);

module.exports = router;