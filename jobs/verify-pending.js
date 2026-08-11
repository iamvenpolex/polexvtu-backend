"use strict";

const axios = require("axios");

const QUERY_URL =
  "https://easyaccessapi.com.ng/api/live/v1/query-transactions";

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const PENDING_AGE_MINUTES = 3;
const BATCH_SIZE = 20;

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

function isSuccessCode(code) {
  return [200, 201].includes(Number(code));
}

function isFailedCode(code) {
  return [400, 401].includes(Number(code));
}

// ─────────────────────────────────────────────
// RESOLVE SUCCESS
// ─────────────────────────────────────────────

async function markSuccess(db, tx, data) {
  await db`
    UPDATE transactions
    SET
      status = 'success',
      refunded = false,
      api_amount = ${Number(data?.amount || 0)},
      api_response = ${JSON.stringify({
        source: "verify_job",
        code: Number(data?.code),
        status: data?.status,
        retrieved_status: data?.retrieved_status,
        message: data?.message,
        true_response: data?.true_response,
        reference: data?.reference,
        transaction_date: data?.transaction_date,
      })},
      updated_at = NOW()
    WHERE id = ${tx.id}
      AND status = 'pending'
      AND refunded = false
  `;
}

// ─────────────────────────────────────────────
// REFUND FAILED TRANSACTION
// ATOMIC + DOUBLE REFUND PROTECTION
// ─────────────────────────────────────────────

async function refundFailed(db, tx, data) {
  return db.begin(async (sql) => {
    const rows = await sql`
      SELECT
        t.id,
        t.user_id,
        t.amount,
        t.status,
        t.refunded,
        u.balance
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.id = ${tx.id}
      FOR UPDATE OF t, u
    `;

    if (!rows.length) {
      return false;
    }

    const current = rows[0];

    // Already processed.
    if (
      current.status !== "pending" ||
      current.refunded === true
    ) {
      return false;
    }

    const amount = Number(current.amount);
    const currentBalance = Number(current.balance);
    const refundedBalance = currentBalance + amount;

    await sql`
      UPDATE users
      SET balance = balance + ${amount}
      WHERE id = ${current.user_id}
    `;

    await sql`
      UPDATE transactions
      SET
        status = 'failed',
        refunded = true,
        balance_after = ${refundedBalance},
        api_amount = ${Number(data?.amount || 0)},
        api_response = ${JSON.stringify({
          source: "verify_job",
          code: Number(data?.code),
          status: data?.status,
          retrieved_status: data?.retrieved_status,
          message: data?.message,
          true_response: data?.true_response,
          reference: data?.reference,
          transaction_date: data?.transaction_date,
          refund: {
            refunded: true,
            amount,
          },
        })},
        updated_at = NOW()
      WHERE id = ${current.id}
        AND status = 'pending'
        AND refunded = false
    `;

    return true;
  });
}

// ─────────────────────────────────────────────
// VERIFY PENDING TRANSACTIONS
// IMPORTANT:
// Query EasyAccess using provider_reference,
// NOT our client reference.
// ─────────────────────────────────────────────

async function verifyPendingTransactions(db) {
  try {
    const pending = await db`
      SELECT
        t.id,
        t.reference,
        t.provider_reference,
        t.user_id,
        t.type,
        t.amount,
        t.status,
        t.refunded,
        t.created_at
      FROM transactions t
      WHERE t.status = 'pending'
        AND t.refunded = false
        AND t.provider_reference IS NOT NULL
        AND t.provider_reference != ''
        AND t.created_at < NOW() -
          (${PENDING_AGE_MINUTES} * INTERVAL '1 minute')
      ORDER BY t.created_at ASC
      LIMIT ${BATCH_SIZE}
    `;

    if (!pending.length) {
      return;
    }

    console.log(
      `🔍 Verifying ${pending.length} pending EasyAccess transaction(s)...`
    );

    for (const tx of pending) {
      try {
        console.log(
          `🔎 Checking ${tx.reference} using provider reference ${tx.provider_reference}`
        );

        const response = await axios.post(
          QUERY_URL,
          {
            reference: tx.provider_reference,
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
        const queryStatus = data?.status;
        const retrievedStatus = data?.retrieved_status;

        console.log(
          `🔍 Query result ${tx.reference}:`,
          {
            provider_reference: tx.provider_reference,
            code,
            status: queryStatus,
            retrieved_status: retrievedStatus,
          }
        );

        // ─────────────────────────────────────────────
        // SUCCESS
        // ─────────────────────────────────────────────

        if (
          isSuccess(retrievedStatus) ||
          isSuccess(queryStatus) ||
          isSuccessCode(code)
        ) {
          await markSuccess(db, tx, data);

          console.log(
            `✅ Verify: ${tx.reference} → SUCCESS`
          );

          continue;
        }

        // ─────────────────────────────────────────────
        // FAILED
        // ─────────────────────────────────────────────

        if (
          isFailed(retrievedStatus) ||
          isFailed(queryStatus) ||
          isFailedCode(code)
        ) {
          const refunded = await refundFailed(
            db,
            tx,
            data
          );

          if (refunded) {
            console.log(
              `❌ Verify: ${tx.reference} → FAILED — ₦${tx.amount} REFUNDED`
            );
          } else {
            console.log(
              `ℹ️ Verify: ${tx.reference} was already resolved`
            );
          }

          continue;
        }

        // ─────────────────────────────────────────────
        // UNKNOWN
        // ─────────────────────────────────────────────

        console.log(
          `⏳ Verify: ${tx.reference} still unresolved — retrying later`
        );
      } catch (queryErr) {
        // 404 "No Records Found" does NOT mean customer
        // should immediately be refunded.
        console.error(
          `⚠️ Verify query failed for ${tx.reference}:`,
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

  setTimeout(() => {
    verifyPendingTransactions(db);
  }, FIRST_RUN_DELAY_MS);

  setInterval(() => {
    verifyPendingTransactions(db);
  }, INTERVAL_MS);
};