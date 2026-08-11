"use strict";

const axios = require("axios");

const QUERY_URL =
  "https://easyaccessapi.com.ng/api/live/v1/query-transactions";

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;

const INTERVAL_MS = 5 * 60 * 1000;
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

async function verifyPendingTransactions(db) {
  try {
    const pending = await db`
      SELECT
        t.id,
        t.reference,
        t.provider_reference,
        t.api_reference,
        t.user_id,
        t.type,
        t.amount,
        t.status,
        t.refunded
      FROM transactions t
      WHERE t.status = 'pending'
        AND t.provider_reference IS NOT NULL
        AND t.provider_reference != ''
        AND t.created_at < NOW() -
          INTERVAL '3 minutes'
      ORDER BY t.created_at ASC
      LIMIT ${BATCH_SIZE}
    `;

    if (!pending.length) {
      return;
    }

    console.log(
      `🔍 Verifying ${pending.length} pending EasyAccess transaction(s)...`
    );

    for (const transaction of pending) {
      try {
        // IMPORTANT:
        // Query EasyAccess with provider reference.
        const queryReference =
          transaction.provider_reference;

        console.log(
          `🔎 Querying EasyAccess: ${transaction.reference} → ${queryReference}`
        );

        const response = await axios.post(
          QUERY_URL,
          {
            reference: queryReference,
          },
          {
            headers: {
              Authorization: `Bearer ${API_TOKEN}`,
              "Cache-Control": "no-cache",
              "Content-Type": "application/json",
            },
            timeout: 15000,

            // Do not throw on provider 4xx.
            validateStatus: () => true,
          }
        );

        const data = response.data || {};

        const code = Number(data.code);

        const queryStatus =
          normalizeStatus(data.status);

        const retrievedStatus =
          normalizeStatus(data.retrieved_status);

        console.log(
          `🔍 EasyAccess Query ${transaction.reference}:`,
          {
            provider_reference: queryReference,
            code,
            status: data.status,
            retrieved_status: data.retrieved_status,
          }
        );

        const apiResponse = {
          source: "verify_job",
          code,
          status: data.status || null,
          retrieved_status:
            data.retrieved_status || null,
          message: data.message || null,
          true_response:
            data.true_response || null,
          reference: data.reference || null,
          amount: data.amount ?? null,
          transaction_date:
            data.transaction_date || null,
        };

        // ─────────────────────────────────────
        // SUCCESS
        // ─────────────────────────────────────

        if (
          isSuccess(retrievedStatus) ||
          isSuccess(queryStatus)
        ) {
          await db`
            UPDATE transactions
            SET
              status = 'success',
              provider_reference = COALESCE(
                ${data.reference || null},
                provider_reference
              ),
              api_reference = COALESCE(
                ${transaction.api_reference},
                reference
              ),
              api_amount = ${data.amount ?? 0},
              api_response = ${JSON.stringify(apiResponse)},
              updated_at = NOW()
            WHERE id = ${transaction.id}
              AND status = 'pending'
          `;

          console.log(
            `✅ Verify SUCCESS: ${transaction.reference}`
          );

          continue;
        }

        // ─────────────────────────────────────
        // FAILED
        // ─────────────────────────────────────

        if (
          isFailed(retrievedStatus) ||
          isFailed(queryStatus)
        ) {
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

            if (!locked.length) {
              return;
            }

            const current = locked[0];

            // Already refunded.
            if (
              current.refunded === true ||
              current.status === "failed"
            ) {
              console.log(
                `ℹ️ Verify already resolved: ${transaction.reference}`
              );
              return;
            }

            const amount = Number(current.amount);

            const refundedBalance =
              Number(current.balance) + amount;

            // Refund exactly once.
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
                api_amount = ${data.amount ?? 0},
                provider_reference = COALESCE(
                  ${data.reference || null},
                  provider_reference
                ),
                balance_after = ${refundedBalance},
                api_response = ${JSON.stringify(apiResponse)},
                updated_at = NOW()
              WHERE id = ${current.id}
            `;

            console.log(
              `💰 Verify REFUND: ${transaction.reference} → ₦${amount}`
            );
          });

          continue;
        }

        // ─────────────────────────────────────
        // 404 / NO RECORD
        //
        // Do NOT refund automatically.
        // It may mean the provider has not indexed
        // the transaction yet.
        // ─────────────────────────────────────

        if (code === 404) {
          console.log(
            `⏳ Verify: ${transaction.reference} not found yet on EasyAccess`
          );

          await db`
            UPDATE transactions
            SET
              api_response = ${JSON.stringify(apiResponse)},
              updated_at = NOW()
            WHERE id = ${transaction.id}
              AND status = 'pending'
          `;

          continue;
        }

        // ─────────────────────────────────────
        // UNKNOWN
        // ─────────────────────────────────────

        console.log(
          `⏳ Verify: ${transaction.reference} unresolved`
        );

        await db`
          UPDATE transactions
          SET
            api_response = ${JSON.stringify(apiResponse)},
            updated_at = NOW()
          WHERE id = ${transaction.id}
            AND status = 'pending'
        `;
      } catch (queryError) {
        console.error(
          `⚠️ Verify failed for ${transaction.reference}:`,
          queryError.message
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

module.exports = function startVerifyJob(db) {
  console.log(
    "🕐 Pending EasyAccess transaction verifier started"
  );

  // First check shortly after server starts.
  setTimeout(() => {
    verifyPendingTransactions(db);
  }, 60 * 1000);

  // Then every 5 minutes.
  setInterval(() => {
    verifyPendingTransactions(db);
  }, INTERVAL_MS);
};