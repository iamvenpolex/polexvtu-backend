"use strict";

const express = require("express");
const crypto = require("crypto");

const router = express.Router();
const db = require("../config/db");

// =====================================================
// STATUS HELPERS
// =====================================================

function normalizeStatus(status) {
return String(status || "")
.trim()
.toLowerCase();
}

function isSuccess(status) {
return [
"success",
"successful",
"completed",
].includes(normalizeStatus(status));
}

function isFailed(status) {
return [
"failed",
"failure",
"cancelled",
"canceled",
].includes(normalizeStatus(status));
}

// =====================================================
// EASYACCESS WEBHOOK
// POST /api/webhook/easyaccess
// =====================================================

router.post("/easyaccess", async (req, res) => {
// Respond immediately
res.status(200).json({
received: true,
});

try {
console.log(
"📬 EasyAccess Webhook:",
req.body
);


const {
  status,
  message,
  client_reference,
  reference,
  transaction_date,
} = req.body;

const clientReference =
  client_reference || null;

const providerReference =
  reference || null;

// ------------------------------------------
// CHECK REFERENCE
// ------------------------------------------

if (
  !clientReference &&
  !providerReference
) {
  console.warn(
    "⚠️ EasyAccess webhook has no reference"
  );

  return;
}

// ------------------------------------------
// FIND TRANSACTION
// ------------------------------------------

const rows = await db`
  SELECT
    id,
    user_id,
    reference,
    provider_reference,
    api_reference,
    status,
    amount,
    refunded,
    balance_before,
    balance_after
  FROM transactions
  WHERE
    reference = ${clientReference || ""}
    OR provider_reference = ${
      providerReference || ""
    }
    OR api_reference = ${
      clientReference || ""
    }
  LIMIT 1
`;

if (!rows.length) {
  console.warn(
    "⚠️ EasyAccess transaction not found:",
    clientReference ||
      providerReference
  );

  return;
}

const transaction = rows[0];

const apiResponse = {
  source: "easyaccess_webhook",
  status,
  message,
  client_reference:
    clientReference,
  reference:
    providerReference,
  transaction_date,
};

// =================================================
// SUCCESS
// =================================================

if (isSuccess(status)) {
  await db`
    UPDATE transactions
    SET
      status = 'success',

      provider_reference =
        COALESCE(
          ${providerReference},
          provider_reference
        ),

      api_reference =
        COALESCE(
          ${clientReference},
          api_reference
        ),

      provider_status =
        ${status},

      api_response =
        ${JSON.stringify(apiResponse)},

      updated_at = NOW()

    WHERE id = ${transaction.id}

      AND status NOT IN (
        'success',
        'failed'
      )
  `;

  console.log(
    `✅ EasyAccess SUCCESS: ${transaction.reference}`
  );

  return;
}

// =================================================
// FAILED + REFUND
// =================================================

if (isFailed(status)) {
  await db.begin(async (tx) => {
    const locked = await tx`
      SELECT
        t.id,
        t.user_id,
        t.amount,
        t.status,
        t.refunded,
        t.balance_before,
        t.balance_after,
        u.balance

      FROM transactions t

      JOIN users u
        ON u.id = t.user_id

      WHERE t.id = ${transaction.id}

      FOR UPDATE OF t, u
    `;

    if (!locked.length) {
      return;
    }

    const current =
      locked[0];

    // --------------------------------------
    // ALREADY RESOLVED
    // --------------------------------------

    if (
      current.refunded === true ||
      current.status === "failed"
    ) {
      console.log(
        `ℹ️ EasyAccess already resolved: ${transaction.reference}`
      );

      return;
    }

    const amount =
      Number(current.amount);

    const currentBalance =
      Number(current.balance || 0);

    const newBalance =
      currentBalance + amount;

    // --------------------------------------
    // REFUND USER
    // --------------------------------------

    await tx`
      UPDATE users
      SET
        balance =
          balance + ${amount}

      WHERE id =
        ${current.user_id}
    `;

    // --------------------------------------
    // UPDATE TRANSACTION
    // --------------------------------------

    await tx`
      UPDATE transactions
      SET

        status = 'failed',

        refunded = TRUE,

        provider_reference =
          COALESCE(
            ${providerReference},
            provider_reference
          ),

        api_reference =
          COALESCE(
            ${clientReference},
            api_reference
          ),

        provider_status =
          ${status},

        balance_before =
          ${currentBalance},

        balance_after =
          ${newBalance},

        description =
          'EasyAccess transaction failed - wallet refunded',

        api_response =
          ${JSON.stringify(
            apiResponse
          )},

        updated_at = NOW()

      WHERE id =
        ${current.id}
    `;

    console.log(
      `💰 EasyAccess REFUND ₦${amount.toFixed(
        2
      )} → user ${current.user_id}`
    );
  });

  return;
}

// =================================================
// UNKNOWN STATUS
// =================================================

console.warn(
  `⚠️ Unknown EasyAccess status: ${status}`
);
```

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

router.post(
"/paymentpoint",
async (req, res) => {
try {
console.log(
"📬 PaymentPoint Webhook:",
req.body
);

```
  // =================================================
  // PAYMENTPOINT SECRET KEY
  // =================================================

  const secretKey =
    process.env.PAYMENTPOINT_SECRET_KEY;

  if (!secretKey) {
    console.error(
      "❌ PAYMENTPOINT_SECRET_KEY is not configured"
    );

    return res.status(500).json({
      message:
        "PaymentPoint webhook configuration missing",
    });
  }

  // =================================================
  // GET SIGNATURE
  // =================================================

  const signature =
    req.headers[
      "paymentpoint-signature"
    ] ||
    req.headers[
      "Paymentpoint-Signature"
    ];

  // =================================================
  // RAW BODY
  // =================================================

  if (!req.rawBody) {
    console.error(
      "❌ Raw PaymentPoint webhook body is unavailable"
    );

    return res.status(400).json({
      message:
        "Raw webhook body unavailable",
    });
  }

  // =================================================
  // VERIFY SIGNATURE
  // =================================================

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(req.rawBody)
      .digest("hex");

  const receivedSignature =
    String(signature || "").trim();

  if (
    !receivedSignature ||
    expectedSignature.length !==
      receivedSignature.length ||
    !crypto.timingSafeEqual(
      Buffer.from(
        expectedSignature,
        "utf8"
      ),
      Buffer.from(
        receivedSignature,
        "utf8"
      )
    )
  ) {
    console.warn(
      "❌ Invalid PaymentPoint webhook signature"
    );

    return res.status(401).json({
      message:
        "Invalid signature",
    });
  }

  // =================================================
  // PAYMENTPOINT DATA
  // =================================================

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

  // =================================================
  // TRANSACTION ID
  // =================================================

  if (!transaction_id) {
    console.warn(
      "⚠️ PaymentPoint webhook missing transaction_id"
    );

    return res.status(400).json({
      message:
        "Missing transaction_id",
    });
  }

  // =================================================
  // ONLY PROCESS SUCCESSFUL TRANSACTIONS
  // =================================================

  if (
    !isSuccess(
      transaction_status
    )
  ) {
    console.log(
      `ℹ️ PaymentPoint transaction status: ${transaction_status}`
    );

    return res.status(200).json({
      received: true,
    });
  }

  // =================================================
  // PAYMENT AMOUNT
  //
  // IMPORTANT:
  //
  // amount_paid = amount customer sent
  //
  // settlement_amount = amount AFTER
  // PaymentPoint's 0.5% fee
  //
  // Therefore:
  //
  // ₦100 payment
  // ₦0.50 fee
  // ₦99.50 settlement
  //
  // User wallet receives ₦99.50.
  // =================================================

  const paymentAmount =
    Number(
      settlement_amount || 0
    );

  if (
    !Number.isFinite(
      paymentAmount
    ) ||
    paymentAmount <= 0
  ) {
    console.warn(
      "⚠️ Invalid PaymentPoint settlement amount:",
      settlement_amount
    );

    return res.status(400).json({
      message:
        "Invalid payment amount",
    });
  }

  // =================================================
  // FIND USER BY VIRTUAL ACCOUNT
  // =================================================

  let userRows = [];

  // -----------------------------------------------
  // PRIMARY METHOD:
  // RECEIVER ACCOUNT NUMBER
  // -----------------------------------------------

  if (
    receiver?.account_number
  ) {
    userRows = await db`
      SELECT
        u.id AS user_id,
        va.id AS virtual_account_id,
        va.account_number,
        va.customer_id

      FROM virtual_accounts va

      JOIN users u
        ON u.id = va.user_id

      WHERE va.account_number =
        ${receiver.account_number}

      LIMIT 1
    `;
  }

  // -----------------------------------------------
  // FALLBACK:
  // PAYMENTPOINT CUSTOMER ID
  // -----------------------------------------------

  if (
    !userRows.length &&
    customer?.customer_id
  ) {
    userRows = await db`
      SELECT
        u.id AS user_id,
        va.id AS virtual_account_id,
        va.account_number,
        va.customer_id

      FROM virtual_accounts va

      JOIN users u
        ON u.id = va.user_id

      WHERE va.customer_id =
        ${customer.customer_id}

      LIMIT 1
    `;
  }

  // =================================================
  // USER NOT FOUND
  // =================================================

  if (!userRows.length) {
    console.warn(
      "⚠️ PaymentPoint user not found",
      {
        transaction_id,
        receiver_account:
          receiver?.account_number ||
          null,
        customer_id:
          customer?.customer_id ||
          null,
      }
    );

    /*
     * Return 200 so PaymentPoint does
     * not continuously retry the webhook.
     */

    return res.status(200).json({
      received: true,
    });
  }

  const userId =
    userRows[0].user_id;

  // =================================================
  // DATABASE TRANSACTION
  // =================================================

  await db.begin(async (tx) => {
    // =================================================
    // DUPLICATE WEBHOOK PROTECTION
    // =================================================

    const existing =
      await tx`
        SELECT
          id,
          user_id,
          amount,
          status
        FROM transactions
        WHERE provider_reference =
          ${transaction_id}
        LIMIT 1
      `;

    if (existing.length) {
      console.log(
        `ℹ️ PaymentPoint transaction already processed: ${transaction_id}`
      );

      return;
    }

    // =================================================
    // LOCK USER BALANCE
    // =================================================

    const lockedUser =
      await tx`
        SELECT
          id,
          balance
        FROM users
        WHERE id =
          ${userId}
        FOR UPDATE
      `;

    if (!lockedUser.length) {
      throw new Error(
        `User ${userId} not found`
      );
    }

    // =================================================
    // BALANCE BEFORE
    // =================================================

    const balanceBefore =
      Number(
        lockedUser[0].balance || 0
      );

    // =================================================
    // BALANCE AFTER
    // =================================================

    const balanceAfter =
      balanceBefore +
      paymentAmount;

    // =================================================
    // CREDIT USER WALLET
    // =================================================

    await tx`
      UPDATE users
      SET
        balance =
          balance + ${paymentAmount}

      WHERE id =
        ${userId}
    `;

    // =================================================
    // CREATE TRANSACTION HISTORY
    // =================================================

    await tx`
      INSERT INTO transactions (
        user_id,
        reference,
        type,
        amount,
        status,
        via,
        description,
        balance_before,
        balance_after,
        provider_reference,
        provider_status,
        refunded,
        api_response,
        created_at,
        updated_at
      )

      VALUES (
        ${userId},

        ${`PP-${transaction_id}`},

        'deposit',

        ${paymentAmount},

        'success',

        'paymentpoint',

        'Wallet funded via PaymentPoint',

        ${balanceBefore},

        ${balanceAfter},

        ${transaction_id},

        ${transaction_status},

        FALSE,

        ${JSON.stringify({
          source:
            "paymentpoint_webhook",

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

    // =================================================
    // LOG
    // =================================================

    console.log(
      "=========================================="
    );

    console.log(
      "💰 PAYMENTPOINT DEPOSIT"
    );

    console.log(
      `👤 User ID: ${userId}`
    );

    console.log(
      `💵 Amount Paid: ₦${Number(
        amount_paid || 0
      ).toFixed(2)}`
    );

    console.log(
      `💸 PaymentPoint Fee: ₦${Number(
        settlement_fee || 0
      ).toFixed(2)}`
    );

    console.log(
      `💰 User Credit: ₦${paymentAmount.toFixed(
        2
      )}`
    );

    console.log(
      `💳 Balance Before: ₦${balanceBefore.toFixed(
        2
      )}`
    );

    console.log(
      `💳 Balance After: ₦${balanceAfter.toFixed(
        2
      )}`
    );

    console.log(
      `🔖 Provider Reference: ${transaction_id}`
    );

    console.log(
      "=========================================="
    );
  });

  // =================================================
  // SUCCESS RESPONSE
  // =================================================

  return res.status(200).json({
    received: true,
    message:
      "Payment processed successfully",
  });
} catch (err) {
  console.error(
    "❌ PaymentPoint webhook error:",
    err.response?.data ||
      err.message
  );

  return res.status(500).json({
    message:
      "Webhook processing failed",
  });
}


}
);

// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;
