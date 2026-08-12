"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/db");

// =====================================================
// 247API AIRTIME WEBHOOK
//
// POST /api/webhooks/airtime
//
// Provider sends:
//
// {
//   "status": "success",
//   "message": "Order Purchase Successful.",
//   "response": "...",
//   "request-id": "AIRTIME_123",
//   "amount": "100",
//   "network": "MTN",
//   "airtime_type": "VTU",
//   "old_wallet": 782,
//   "new_wallet": 682
// }
// =====================================================

router.post("/airtime", async (req, res) => {
  try {
    const payload = req.body;

    console.log(
      "247API AIRTIME WEBHOOK:",
      JSON.stringify(payload)
    );

    const providerReference =
      payload?.["request-id"] ||
      payload?.request_id ||
      payload?.reference ||
      null;

    if (!providerReference) {
      return res.status(400).json({
        success: false,
        message: "Missing request-id",
      });
    }

    const providerStatus = String(
      payload?.status || ""
    ).toLowerCase();

    if (!["success", "fail", "failed"].includes(providerStatus)) {
      return res.status(200).json({
        success: true,
        message: "Webhook received",
      });
    }

    // =================================================
    // FIND TRANSACTION USING PROVIDER ID
    // =================================================

    const rows = await db`
      SELECT
        id,
        user_id,
        reference,
        provider_reference,
        type,
        amount,
        status,
        refunded,
        network,
        phone,
        balance_before,
        balance_after
      FROM transactions
      WHERE
        provider_reference = ${providerReference}
        OR reference = ${providerReference}
      ORDER BY id DESC
      LIMIT 1
    `;

    const transaction = rows[0];

    if (!transaction) {
      console.error(
        "AIRTIME WEBHOOK: Transaction not found:",
        providerReference
      );

      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    // =================================================
    // IDEMPOTENCY
    //
    // If already success/failed, do not process again.
    // This prevents double cashback/refund.
    // =================================================

    if (
      transaction.status === "success" ||
      transaction.status === "failed"
    ) {
      return res.status(200).json({
        success: true,
        message: "Transaction already processed",
        reference: transaction.reference,
        status: transaction.status,
      });
    }

    const amount = Number(transaction.amount);

    // =================================================
    // SUCCESS
    // =================================================

    if (providerStatus === "success") {
      const cashback = Math.floor(
        amount * 0.01
      );

      const balanceAfterPurchase =
        Number(transaction.balance_after);

      const balanceAfterCashback =
        balanceAfterPurchase + cashback;

      await db.begin(async (sql) => {
        // ---------------------------------------------
        // Update user's wallet
        // ---------------------------------------------

        await sql`
          UPDATE users
          SET balance = ${balanceAfterCashback}
          WHERE id = ${transaction.user_id}
        `;

        // ---------------------------------------------
        // Complete airtime transaction
        // ---------------------------------------------

        await sql`
          UPDATE transactions
          SET
            status = 'success',
            provider_reference = ${providerReference},
            api_amount = ${payload?.amount || amount},
            api_response = ${JSON.stringify(payload)},
            balance_after = ${balanceAfterCashback},
            updated_at = NOW()
          WHERE id = ${transaction.id}
            AND status = 'pending'
        `;

        // ---------------------------------------------
        // Create cashback transaction
        //
        // NOT EXISTS prevents duplicate cashback.
        // ---------------------------------------------

        if (cashback > 0) {
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
              ${transaction.user_id},
              ${`CASHBACK_${transaction.reference}`},
              ${providerReference},
              'cashback',
              ${cashback},
              'success',
              false,
              NOW(),
              ${cashback},
              ${transaction.network},
              ${transaction.phone},
              'cashback',
              ${`1% cashback on airtime for ${transaction.phone}`},
              ${balanceAfterPurchase},
              ${balanceAfterCashback}
            WHERE NOT EXISTS (
              SELECT 1
              FROM transactions
              WHERE reference =
                ${`CASHBACK_${transaction.reference}`}
            )
          `;
        }
      });

      console.log(
        `AIRTIME SUCCESS: ${transaction.reference} | Cashback: ₦${cashback}`
      );

      return res.status(200).json({
        success: true,
        message: "Airtime transaction completed",
        reference: transaction.reference,
        provider_reference: providerReference,
        status: "success",
        cashback,
      });
    }

    // =================================================
    // FAILED
    // =================================================

    if (
      providerStatus === "fail" ||
      providerStatus === "failed"
    ) {
      const balanceBefore =
        Number(transaction.balance_before);

      await db.begin(async (sql) => {
        // ---------------------------------------------
        // Refund wallet
        // ---------------------------------------------

        await sql`
          UPDATE users
          SET balance = ${balanceBefore}
          WHERE id = ${transaction.user_id}
        `;

        // ---------------------------------------------
        // Mark transaction failed
        // ---------------------------------------------

        await sql`
          UPDATE transactions
          SET
            status = 'failed',
            refunded = true,
            provider_reference = ${providerReference},
            api_amount = ${payload?.amount || amount},
            api_response = ${JSON.stringify(payload)},
            balance_after = ${balanceBefore},
            updated_at = NOW()
          WHERE id = ${transaction.id}
            AND status = 'pending'
        `;
      });

      console.log(
        `AIRTIME FAILED + REFUNDED: ${transaction.reference}`
      );

      return res.status(200).json({
        success: true,
        message: "Airtime failed and wallet refunded",
        reference: transaction.reference,
        provider_reference: providerReference,
        status: "failed",
        refunded: true,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Webhook received",
    });
  } catch (error) {
    console.error(
      "AIRTIME WEBHOOK ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed",
    });
  }
});

module.exports = router;