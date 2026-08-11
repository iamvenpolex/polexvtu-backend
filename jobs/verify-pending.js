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

function getProviderReference(apiResponse) {
  if (!apiResponse) return null;

  try {
    const data =
      typeof apiResponse === "string"
        ? JSON.parse(apiResponse)
        : apiResponse;

    return data?.reference || null;
  } catch (err) {
    console.error(
      "⚠️ Could not parse api_response:",
      err.message
    );

    return null;
  }
}

// ─────────────────────────────────────────────
// REFUND TRANSACTION SAFELY
// ─────────────────────────────────────────────

async function refundTransaction(db, tx, apiResponse) {
  await db.begin(async (sql) => {
    /*
     * Only change pending transactions.
     *
     * This prevents a webhook and verifier from
     * refunding the same transaction twice.
     */

    const updated = await sql`
      UPDATE transactions
      SET
        status = 'failed',
        api_response = ${JSON.stringify(apiResponse)},
        updated_at = NOW()
      WHERE id = ${tx.id}
        AND status = 'pending'
      RETURNING id
    `;

    if (!updated.length) {
      console.log(
        `ℹ️ Refund skipped: ${tx.reference} already resolved`
      );

      return;
    }

    /*
     * Refund the exact amount that was deducted.
     */
    await sql`
      UPDATE users
      SET balance = balance + ${Number(tx.amount)}
      WHERE id = ${tx.user_id}
    `;

    /*
     * Set balance_after to the actual balance
     * after the refund.
     */
    await sql`
      UPDATE transactions
      SET balance_after = (
        SELECT balance
        FROM users
        WHERE id = ${tx.user_id}
      )
      WHERE id = ${tx.id}
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
    console.log(
      `✅ Verify: ${tx.reference} → SUCCESS`
    );
  } else {
    console.log(
      `ℹ️ Verify: ${tx.reference} already resolved`
    );
  }
}

// ─────────────────────────────────────────────
// VERIFY PENDING TRANSACTIONS
// ─────────────────────────────────────────────

async function verifyPendingTransactions(db) {
  try {
    /*
     * This verifier is NOT limited to data.
     *
     * It can verify any pending EasyAccess transaction
     * that has an EasyAccess provider reference.
     *
     * We exclude internal TapAm transactions that do
     * not belong to EasyAccess.
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
        AND t.created_at <
          NOW() - make_interval(mins => ${PENDING_AGE_MINUTES})
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

        const providerReference =
          getProviderReference(tx.api_response);

        if (!providerReference) {
          /*
           * We don't have the EasyAccess reference yet.
           *
           * DO NOT REFUND.
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

        const queryStatus =
          normalizeStatus(data?.status);

        const retrievedStatus =
          normalizeStatus(data?.retrieved_status);

        console.log(
          `🔍 EA Query: ${tx.reference}`,
          {
            type: tx.type,
            provider_reference: providerReference,
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
        // DEFINITIVE FAILURE
        // ─────────────────────────────────────────

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
        // 404 — NO RECORD FOUND
        // ─────────────────────────────────────────

        if (code === 404) {
          console.log(
            `⏳ Verify: ${tx.reference} → EasyAccess has no record for ${providerReference}.`
          );

          /*
           * DO NOT REFUND.
           *
           * We try again during the next cycle.
           */

          continue;
        }

        // ─────────────────────────────────────────
        // 400 / 401
        // ─────────────────────────────────────────

        if (code === 400 || code === 401) {
          console.log(
            `⚠️ Verify: ${tx.reference} returned ${code} without a definitive transaction failure.`
          );

          continue;
        }

        // ─────────────────────────────────────────
        // UNKNOWN
        // ─────────────────────────────────────────

        console.log(
          `⏳ Verify: ${tx.reference} still unresolved — retrying later.`
        );

      } catch (queryErr) {
        /*
         * Query/network errors are NOT transaction failures.
         *
         * Never refund because the Query API could not
         * be reached.
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

  // First verification after 1 minute
  setTimeout(() => {
    verifyPendingTransactions(db);
  }, 60 * 1000);

  // Then every 5 minutes
  setInterval(() => {
    verifyPendingTransactions(db);
  }, INTERVAL_MS);
};