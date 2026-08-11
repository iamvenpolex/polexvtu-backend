"use strict";

const axios = require("axios");

const QUERY_URL =
  "https://easyaccessapi.com.ng/api/live/v1/query-transactions";

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

const INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
const PENDING_AGE_MINUTES = 3;
const BATCH_SIZE = 20;

// ─────────────────────────────────────────────
// STATUS HELPERS
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

// ─────────────────────────────────────────────
// GET EASYACCESS PROVIDER REFERENCE
// ─────────────────────────────────────────────
//
// Your transaction.reference:
//   ref_1786483958842
//
// EasyAccess reference:
//   DATA57646119bea4b4
//
// The Query Transaction API needs the EasyAccess
// reference, NOT your client_reference.
// ─────────────────────────────────────────────

function getProviderReference(apiResponse) {
  if (!apiResponse) return null;

  try {
    const data =
      typeof apiResponse === "string"
        ? JSON.parse(apiResponse)
        : apiResponse;

    return data?.reference || null;
  } catch (err) {
    console.error("⚠️ Could not parse api_response:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// REFUND TRANSACTION SAFELY
// ─────────────────────────────────────────────
//
// IMPORTANT:
// Only refund if transaction is still pending.
//
// This prevents:
// - double refunds
// - webhook + verifier both refunding
// - race conditions
// ─────────────────────────────────────────────

async function refundTransaction(db, tx, apiResponse) {
  await db.begin(async (sql) => {
    // First mark the transaction as failed ONLY if
    // it is still pending.
    const updated = await sql`
      UPDATE transactions
      SET
        status = 'failed',
        balance_after = (
          SELECT balance + ${Number(tx.amount)}
          FROM users
          WHERE id = ${tx.user_id}
        ),
        api_response = ${JSON.stringify(apiResponse)},
        updated_at = NOW()
      WHERE id = ${tx.id}
        AND status = 'pending'
      RETURNING id
    `;

    // If nothing was updated, another process
    // already resolved/refunded this transaction.
    if (!updated.length) {
      console.log(
        `ℹ️ Refund skipped: ${tx.reference} already resolved`
      );
      return;
    }

    // Refund the customer's wallet.
    await sql`
      UPDATE users
      SET balance = balance + ${Number(tx.amount)}
      WHERE id = ${tx.user_id}
    `;
  });
}

// ─────────────────────────────────────────────
// MARK SUCCESS SAFELY
// ─────────────────────────────────────────────

async function markSuccess(db, tx, apiResponse) {
  const updated = await db`
    UPDATE transactions
    SET
      status = 'success',
      api_amount = ${apiResponse.amount || 0},
      api_response = ${JSON.stringify(apiResponse)},
      updated_at = NOW()
    WHERE id = ${tx.id}
      AND status = 'pending'
    RETURNING id
  `;

  if (updated.length) {
    console.log(`✅ Verify: ${tx.reference} → SUCCESS`);
  } else {
    console.log(
      `ℹ️ Verify: ${tx.reference} already resolved by another process`
    );
  }
}

// ─────────────────────────────────────────────
// VERIFY PENDING TRANSACTIONS
// ─────────────────────────────────────────────

async function verifyPendingTransactions(db) {
  try {
    /*
     * IMPORTANT:
     *
     * We are intentionally NOT doing:
     *
     * WHERE type = 'data'
     *
     * because EasyAccess Query Transaction API can be
     * used to verify transactions from other services too.
     */

    const pending = await db`
      SELECT
        t.id,
        t.reference,
        t.user_id,
        t.type,
        t.amount,
        t.status,
        t.api_response,
        t.created_at
      FROM transactions t
      WHERE t.status = 'pending'
        AND t.created_at < NOW() - INTERVAL '${PENDING_AGE_MINUTES} minutes'
        AND t.type NOT IN (
          'tapam-transfer',
          'reward-to-wallet',
          'cashback'
        )
      ORDER BY t.created_at ASC
      LIMIT ${BATCH_SIZE}
    `;

    if (!pending.length) {
      return;
    }

    console.log(
      `🔍 Verifying ${pending.length} pending transaction(s)...`
    );

    for (const tx of pending) {
      try {
        // ─────────────────────────────────────────
        // GET PROVIDER REFERENCE
        // ─────────────────────────────────────────

        const providerReference = getProviderReference(
          tx.api_response
        );

        if (!providerReference) {
          /*
           * This is important.
           *
           * If the original EasyAccess purchase request
           * timed out before returning a response, we may
           * not have the provider reference yet.
           *
           * DO NOT REFUND.
           *
           * The webhook or another mechanism may still
           * resolve it.
           */

          console.log(
            `⏳ Verify: ${tx.reference} has no EasyAccess provider reference yet.`
          );

          continue;
        }

        console.log(
          `🔎 Verify: ${tx.reference} → EA reference ${providerReference}`
        );

        // ─────────────────────────────────────────
        // QUERY EASYACCESS
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
        const retrievedStatus = normalizeStatus(
          data?.retrieved_status
        );

        console.log(`🔍 EA Query: ${tx.reference}`, {
          type: tx.type,
          provider_reference: providerReference,
          code,
          status: queryStatus,
          retrieved_status: retrievedStatus,
        });

        // ─────────────────────────────────────────
        // SUCCESS
        // ─────────────────────────────────────────

        /*
         * The important field here is retrieved_status.
         *
         * Example:
         *
         * code: 200
         * status: success
         * retrieved_status: Successful
         *
         * This is definitely successful.
         */

        if (
          isSuccess(retrievedStatus) ||
          isSuccess(queryStatus)
        ) {
          await markSuccess(db, tx, {
            source: "verify_job",
            code,
            status: data?.status,
            retrieved_status: data?.retrieved_status,
            reference: data?.reference,
            amount: data?.amount,
            message: data?.message,
            true_response: data?.true_response,
            transaction_date: data?.transaction_date,
          });

          continue;
        }

        // ─────────────────────────────────────────
        // FAILED
        // ─────────────────────────────────────────

        /*
         * ONLY refund when EasyAccess explicitly tells us
         * that the transaction failed.
         *
         * Do NOT treat 404 as failed.
         */

        if (
          isFailed(retrievedStatus) ||
          isFailed(queryStatus)
        ) {
          await refundTransaction(db, tx, {
            source: "verify_job",
            code,
            status: data?.status,
            retrieved_status: data?.retrieved_status,
            reference: data?.reference,
            amount: data?.amount,
            message: data?.message,
            true_response: data?.true_response,
            transaction_date: data?.transaction_date,
          });

          console.log(
            `❌ Verify: ${tx.reference} → FAILED — ₦${tx.amount} refunded`
          );

          continue;
        }

        // ─────────────────────────────────────────
        // 400 / 401
        // ─────────────────────────────────────────
        //
        // Your documentation says 400/401 are failed
        // request codes. However, we still require that
        // the transaction itself is explicitly failed
        // before refunding.
        //
        // This avoids refunding because of a temporary
        // provider/API issue.
        // ─────────────────────────────────────────

        if (code === 400 || code === 401) {
          console.log(
            `⚠️ Verify: ${tx.reference} returned code ${code} but no definitive failed transaction status.`
          );

          continue;
        }

        // ─────────────────────────────────────────
        // 404 — NO RECORD FOUND
        // ─────────────────────────────────────────

        if (code === 404) {
          console.log(
            `⏳ Verify: ${tx.reference} → EasyAccess has no record for provider reference ${providerReference}.`
          );

          /*
           * DO NOT REFUND.
           *
           * Retry during the next verification cycle.
           */

          continue;
        }

        // ─────────────────────────────────────────
        // UNKNOWN / PENDING
        // ─────────────────────────────────────────

        console.log(
          `⏳ Verify: ${tx.reference} still unresolved — retrying later.`
        );
      } catch (queryErr) {
        /*
         * VERY IMPORTANT:
         *
         * A query/network error does NOT mean the
         * transaction failed.
         *
         * Therefore:
         * DO NOT REFUND.
         */

        console.error(
          `⚠️ Verify: failed to query ${tx.reference}:`,
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
    "🕐 Pending EasyAccess transaction verifier started"
  );

  // First run after 1 minute
  setTimeout(() => {
    verifyPendingTransactions(db);
  }, 60 * 1000);

  // Then every 5 minutes
  setInterval(() => {
    verifyPendingTransactions(db);
  }, INTERVAL_MS);
};