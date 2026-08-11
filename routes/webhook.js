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

router.post("/easyaccess", async (req, res) => {
  // Reply immediately to EasyAccess.
  res.status(200).json({ received: true });

  const {
    status,
    message,
    client_reference,
    reference,
    transaction_date,
  } = req.body;

  console.log("📬 EasyAccess Webhook:", req.body);

  if (!client_reference && !reference) {
    console.warn("⚠️ Webhook has no client/provider reference");
    return;
  }

  try {
    // Find using our client reference first.
    // If unavailable, try provider reference.
    const rows = await db`
      SELECT
        t.id,
        t.user_id,
        t.reference,
        t.provider_reference,
        t.api_reference,
        t.status,
        t.amount,
        t.refunded
      FROM transactions t
      WHERE
        (
          t.reference = ${client_reference || ""}
          OR
          t.provider_reference = ${reference || ""}
          OR
          t.api_reference = ${client_reference || ""}
        )
      LIMIT 1
    `;

    if (!rows.length) {
      console.warn(
        `⚠️ Webhook transaction not found: ${client_reference || reference}`
      );
      return;
    }

    const transaction = rows[0];

    // ─────────────────────────────────────────
    // SUCCESS
    // ─────────────────────────────────────────

    if (isSuccess(status)) {
      await db`
        UPDATE transactions
        SET
          status = 'success',
          provider_reference = COALESCE(
            ${reference || null},
            provider_reference
          ),
          api_reference = COALESCE(
            ${client_reference || null},
            api_reference
          ),
          api_response = ${JSON.stringify({
            source: "webhook",
            status,
            message,
            client_reference,
            reference,
            transaction_date,
          })},
          updated_at = NOW()
        WHERE id = ${transaction.id}
          AND status NOT IN ('success', 'failed')
      `;

      console.log(
        `✅ Webhook SUCCESS: ${transaction.reference}`
      );

      return;
    }

    // ─────────────────────────────────────────
    // FAILED
    // ─────────────────────────────────────────

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

        // Prevent double refund.
        if (
          current.refunded === true ||
          current.status === "failed"
        ) {
          console.log(
            `ℹ️ Webhook already resolved: ${transaction.reference}`
          );
          return;
        }

        const amount = Number(current.amount);
        const newBalance =
          Number(current.balance) + amount;

        await tx`
          UPDATE users
          SET balance = balance + ${amount}
          WHERE id = ${current.user_id}
        `;

        await tx`
          UPDATE transactions
          SET
            status = 'failed',
            refunded = TRUE,
            provider_reference = COALESCE(
              ${reference || null},
              provider_reference
            ),
            api_reference = COALESCE(
              ${client_reference || null},
              api_reference
            ),
            balance_after = ${newBalance},
            api_response = ${JSON.stringify({
              source: "webhook",
              status,
              message,
              client_reference,
              reference,
              transaction_date,
            })},
            updated_at = NOW()
          WHERE id = ${current.id}
        `;

        console.log(
          `💰 REFUNDED ₦${amount} → user ${current.user_id}`
        );
      });

      return;
    }

    console.warn(
      `⚠️ Unknown EasyAccess webhook status: ${status}`
    );
  } catch (err) {
    console.error(
      "❌ Webhook processing error:",
      err.message
    );
  }
});

module.exports = router;