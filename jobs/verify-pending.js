"use strict";

/**
 * PENDING TRANSACTION VERIFIER
 *
 * Purpose:
 * - Backup for missed EasyAccess webhooks.
 * - Queries EasyAccess for pending data transactions.
 * - Uses the EasyAccess provider reference, NOT the client reference.
 * - Prevents double refunds.
 *
 * Start from server.js:
 * const startVerifyJob = require("./jobs/verify-pending");
 * startVerifyJob(db);
 */

const axios = require("axios");

const QUERY_URL =
  "https://easyaccessapi.com.ng/api/live/v1/query-transactions";

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

const INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
const PENDING_AGE_MINUTES = 3;
const BATCH_SIZE = 20;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isSuccess(status) {
  return ["success", "successful"].includes(normalizeStatus(status));
}

function isFailed(status) {
  return normalizeStatus(status) === "failed";
}

function isPending(status) {
  return normalizeStatus(status) === "pending";
}

// ─────────────────────────────────────────────
// VERIFY PENDING TRANSACTIONS
// ─────────────────────────────────────────────

async function verifyPendingTransactions(db) {
  try {
    /**
     * IMPORTANT:
     *
     * provider_reference is extracted from api_response.
     *
     * Your transaction.reference is your own client_reference:
     *     ref_1785526778823
     *
     * EasyAccess query API needs:
     *     DATA9a1e1485ad9273
     *
     * So we first read the provider reference from api_response.
     */

    const pending = await db`
      SELECT
        t.id,
        t.reference AS client_reference,
        t.user_id,
        t.amount,
        t.balance_before,
        t.balance_after,
        t.api_response,
        u.balance AS current_balance
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.type = 'data'
        AND t.status = 'pending'
        AND t.created_at < NOW() - (${PENDING_AGE_MINUTES} * INTERVAL '1 minute')
      ORDER BY t.created_at ASC
      LIMIT ${BATCH_SIZE}
    `;

    if (!pending.length) {
      return;
    }

    console.log(
      `🔍 Verifying ${pending.length} pending data transaction(s)...`
    );

    for (const tx of pending) {
      try {
        // ─────────────────────────────────────────
        // Get EasyAccess provider reference
        // ─────────────────────────────────────────

        let savedApiResponse = {};

        try {
          if (tx.api_response) {
            savedApiResponse =
              typeof tx.api_response === "string"
                ? JSON.parse(tx.api_response)
                : tx.api_response;
          }
        } catch {
          savedApiResponse = {};
        }

        const providerReference =
          savedApiResponse?.reference ||
          savedApiResponse?.provider_reference ||
          savedApiResponse?.easyaccess_reference ||
          null;

        /**
         * If we don't have the provider reference yet,
         * don't query using the client reference.
         *
         * This prevents:
         *
         * ref_1785526778823
         *
         * being incorrectly sent to EasyAccess.
         */

        if (!providerReference) {
          console.log(
            `⏳ Verify: ${tx.client_reference} has no EasyAccess provider reference yet.`
          );

          continue;
        }

        console.log(
          `🔎 Querying EasyAccess transaction: ${providerReference}`
        );

        // ─────────────────────────────────────────
        // Query EasyAccess
        // ─────────────────────────────────────────

        const response = await axios.post(
          QUERY_URL,
          {
            reference: providerReference,
          },
          {
            headers: {
              Authorization: `Bearer ${API_TOKEN}`,
              "Cache-Control": "no-cache",
              "Content-Type": "application/json",
            },
            timeout: 15000,
          }
        );

        const data = response.data;

        const code = Number(data?.code);
        const queryStatus = normalizeStatus(data?.status);
        const retrievedStatus = normalizeStatus(data?.retrieved_status);

        console.log(
          `🔍 EasyAccess query ${providerReference}:`,
          {
            code,
            status: queryStatus,
            retrieved_status: retrievedStatus,
          }
        );

        // ─────────────────────────────────────────
        // SUCCESS
        // ─────────────────────────────────────────

        if (
          isSuccess(retrievedStatus) ||
          isSuccess(queryStatus)
        ) {
          const apiResponse = {
            source: "verify_job",
            code,
            status: data?.status,
            retrieved_status: data?.retrieved_status,
            message: data?.message,
            true_response: data?.true_response,
            reference: data?.reference || providerReference,
            amount: data?.amount,
            transaction_date: data?.transaction_date,
          };

          await db`
            UPDATE transactions
            SET
              status = 'success',
              api_amount = ${data?.amount ? Number(data.amount) : 0},
              api_response = ${JSON.stringify(apiResponse)},
              updated_at = NOW()
            WHERE id = ${tx.id}
              AND status = 'pending'
          `;

          console.log(
            `✅ Verify: ${tx.client_reference} → SUCCESS`
          );

          continue;
        }

        // ─────────────────────────────────────────
        // FAILED
        // ─────────────────────────────────────────

        if (
          isFailed(retrievedStatus) ||
          isFailed(queryStatus)
        ) {
          /**
           * VERY IMPORTANT:
           *
           * Only refund if transaction is STILL pending.
           *
           * If webhook already changed it to failed,
           * this UPDATE will affect 0 rows.
           *
           * Therefore the customer cannot receive
           * the refund twice.
           */

          await db.begin(async (sql) => {
            const locked = await sql`
              SELECT
                id,
                user_id,
                amount,
                balance_before,
                status
              FROM transactions
              WHERE id = ${tx.id}
              FOR UPDATE
            `;

            if (!locked.length) {
              return;
            }

            const currentTx = locked[0];

            // Webhook may have already processed it.
            if (currentTx.status !== "pending") {
              console.log(
                `ℹ️ Verify: ${tx.client_reference} already resolved as ${currentTx.status}. No refund made.`
              );

              return;
            }

            const refundAmount = Number(currentTx.amount);

            // Refund exactly the amount originally deducted.
            await sql`
              UPDATE users
              SET balance = balance + ${refundAmount}
              WHERE id = ${currentTx.user_id}
            `;

            /**
             * The balance_after here is the balance AFTER refund.
             *
             * We calculate it from the user's current balance
             * before applying the refund.
             */
            const currentUser = await sql`
              SELECT balance
              FROM users
              WHERE id = ${currentTx.user_id}
              FOR UPDATE
            `;

            const balanceAfterRefund =
              Number(currentUser[0].balance);

            const apiResponse = {
              source: "verify_job",
              code,
              status: data?.status,
              retrieved_status: data?.retrieved_status,
              message: data?.message,
              true_response: data?.true_response,
              reference: data?.reference || providerReference,
              amount: data?.amount,
              transaction_date: data?.transaction_date,
              refunded: true,
              refund_amount: refundAmount,
            };

            await sql`
              UPDATE transactions
              SET
                status = 'failed',
                api_amount = ${
                  data?.amount ? Number(data.amount) : 0
                },
                balance_after = ${balanceAfterRefund},
                api_response = ${JSON.stringify(apiResponse)},
                updated_at = NOW()
              WHERE id = ${currentTx.id}
                AND status = 'pending'
            `;

            console.log(
              `❌ Verify: ${tx.client_reference} → FAILED`
            );

            console.log(
              `💰 Refund: ₦${refundAmount} → user ${currentTx.user_id}`
            );
          });

          continue;
        }

        // ─────────────────────────────────────────
        // 404 / NO RECORD
        // ─────────────────────────────────────────

        if (code === 404) {
          /**
           * DO NOT refund immediately.
           *
           * A timeout can happen after EasyAccess has received
           * the request but before your server receives the response.
           *
           * Give EasyAccess more time to register the transaction.
           */

          console.log(
            `⏳ Verify: ${tx.client_reference} → EasyAccess record not found yet. Will retry.`
          );

          continue;
        }

        // ─────────────────────────────────────────
        // UNKNOWN
        // ─────────────────────────────────────────

        console.log(
          `⏳ Verify: ${tx.client_reference} unresolved. Will retry next cycle.`
        );

      } catch (queryErr) {
        console.error(
          `⚠️ Verify: failed to query ${tx.client_reference}:`,
          queryErr.response?.data || queryErr.message
        );
      }
    }
  } catch (err) {
    console.error(
      "❌ Verify job error:",
      err.message
    );
  }
}

// ─────────────────────────────────────────────
// START JOB
// ─────────────────────────────────────────────

module.exports = function startVerifyJob(db) {
  console.log(
    "🕐 Pending transaction verifier started"
  );

  /**
   * First check after 1 minute.
   */
  setTimeout(() => {
    verifyPendingTransactions(db);
  }, 60 * 1000);

  /**
   * Then every 5 minutes.
   */
  setInterval(() => {
    verifyPendingTransactions(db);
  }, INTERVAL_MS);
};