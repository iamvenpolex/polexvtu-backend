require("dotenv").config();
const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

const USER_ID = process.env.NELLO_USER_ID;
const API_KEY = process.env.NELLO_API_KEY;
const CALLBACK_URL = process.env.NELLO_CALLBACK_URL;

// ------------------------
// Middleware: Protect Routes
// ------------------------
const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Not authorized" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Not authorized" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      message: "Token invalid or expired",
    });
  }
};

// ------------------------
// Map Nello Status
// ------------------------
function mapNelloStatus(raw) {
  const { statuscode, status } = raw;

  if (
    statuscode === "200" ||
    status === "ORDER_COMPLETED"
  ) {
    return "success";
  }

  if (
    statuscode === "100" ||
    statuscode === "201" ||
    status === "ORDER_RECEIVED" ||
    status === "ORDER_ONHOLD"
  ) {
    return "pending";
  }

  if (
    statuscode === "402" ||
    status === "ORDER_FAILED" ||
    status === "INSUFFICIENT_BALANCE"
  ) {
    return "failed";
  }

  if (status === "ORDER_CANCELLED") {
    return "cancelled";
  }

  return "failed";
}

// ------------------------
// Queue
// ------------------------
const airtimeQueue = [];
let isProcessingQueue = false;

// ------------------------
// Process Queue
// ------------------------
async function processQueue() {
  if (isProcessingQueue) return;

  isProcessingQueue = true;

  while (airtimeQueue.length > 0) {
    const tx = airtimeQueue.shift();

    try {
      const url = `https://www.nellobytesystems.com/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&MobileNetwork=${tx.network}&Amount=${tx.amount}&MobileNumber=${tx.phone}&RequestID=${tx.reference}&CallBackURL=${CALLBACK_URL}${
        tx.bonusType ? `&BonusType=${tx.bonusType}` : ""
      }`;

      const response = await axios.get(url);

      const raw = response.data;

      console.log(
        `📡 Processed queued transaction ${tx.reference}:`,
        raw
      );

      const finalStatus = mapNelloStatus(raw);

      await db.begin(async (sql) => {
        // update transaction
        await sql`
          UPDATE transactions
          SET
            status = ${finalStatus},
            api_response = ${JSON.stringify(raw)}
          WHERE reference = ${tx.reference}
        `;

        // refund if failed/cancelled/insufficient balance
        if (
          raw.status === "INSUFFICIENT_BALANCE" ||
          finalStatus === "failed" ||
          finalStatus === "cancelled"
        ) {
          const [transaction] = await sql`
            SELECT user_id, amount
            FROM transactions
            WHERE reference = ${tx.reference}
          `;

          if (transaction) {
            const [user] = await sql`
              SELECT balance
              FROM users
              WHERE id = ${transaction.user_id}
            `;

            const refundedBalance =
              Number(user.balance) +
              Number(transaction.amount);

            await sql`
              UPDATE users
              SET balance = ${refundedBalance}
              WHERE id = ${transaction.user_id}
            `;
          }
        }
      });
    } catch (err) {
      console.error(
        `❌ Queue failed for ${tx.reference}:`,
        err.message
      );

      // retry later
      airtimeQueue.push(tx);

      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  isProcessingQueue = false;
}

// ------------------------
// Buy Airtime
// ------------------------
router.post("/buy", protect, async (req, res) => {
  try {
    const {
      network,
      amount,
      phone,
      bonusType,
    } = req.body;

    if (!network || !amount || !phone) {
      return res.status(400).json({
        error: "All fields are required",
      });
    }

    const numericAmount = Number(amount);

    if (numericAmount < 50) {
      return res.status(400).json({
        error: "Minimum amount is 50 Naira",
      });
    }

    const [user] = await db`
      SELECT id, balance
      FROM users
      WHERE id = ${req.user.id}
    `;

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    if (user.balance < numericAmount) {
      return res.status(400).json({
        error: "Insufficient wallet balance",
      });
    }

    const balanceBefore = Number(user.balance);
    const balanceAfter =
      balanceBefore - numericAmount;

    const requestID = "REQ" + Date.now();

    await db.begin(async (sql) => {
      await sql`
        INSERT INTO transactions (
          user_id,
          reference,
          type,
          amount,
          status,
          created_at,
          api_amount,
          network,
          phone,
          via,
          description,
          balance_before,
          balance_after
        )
        VALUES (
          ${req.user.id},
          ${requestID},
          'airtime',
          ${numericAmount},
          'pending',
          NOW(),
          ${numericAmount},
          ${network},
          ${phone},
          'wallet',
          ${`Airtime purchase for ${phone}`},
          ${balanceBefore},
          ${balanceAfter}
        )
      `;

      await sql`
        UPDATE users
        SET balance = ${balanceAfter}
        WHERE id = ${req.user.id}
      `;
    });

    // queue transaction
    airtimeQueue.push({
      reference: requestID,
      network,
      amount: numericAmount,
      phone,
      bonusType,
    });

    processQueue();

    res.json({
      success: true,
      status: "pending",
      requestID,
      balanceAfter,
      message:
        "Transaction queued. Final status will update automatically.",
    });
  } catch (err) {
    console.error("❌ BUY AIRTIME ERROR:", err);

    return res.status(500).json({
      error: "Server error",
      details: err.message,
    });
  }
});

// ------------------------
// Callback
// ------------------------
router.get("/callback", async (req, res) => {
  try {
    const {
      orderid,
      requestid,
      statuscode,
      orderstatus,
    } = req.query;

    const ref = requestid || orderid;

    const finalStatus = mapNelloStatus({
      statuscode,
      status: orderstatus,
    });

    await db.begin(async (sql) => {
      await sql`
        UPDATE transactions
        SET
          status = ${finalStatus},
          api_response = ${JSON.stringify(req.query)}
        WHERE reference = ${ref}
      `;

      if (
        ["failed", "cancelled"].includes(
          finalStatus
        )
      ) {
        const [tx] = await sql`
          SELECT user_id, balance_before
          FROM transactions
          WHERE reference = ${ref}
        `;

        if (tx) {
          await sql`
            UPDATE users
            SET balance = ${tx.balance_before}
            WHERE id = ${tx.user_id}
          `;
        }
      }
    });

    res.send("OK");
  } catch (err) {
    console.error("❌ CALLBACK ERROR:", err);
    res.status(500).send("ERROR");
  }
});

// ------------------------
// Sync Pending Transactions
// ------------------------
router.post("/sync", protect, async (req, res) => {
  try {
    const pendingTx = await db`
      SELECT
        reference,
        network,
        phone,
        amount
      FROM transactions
      WHERE
        user_id = ${req.user.id}
        AND status = 'pending'
    `;

    for (const tx of pendingTx) {
      try {
        const url = `https://www.nellobytesystems.com/APIQueryV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&RequestID=${tx.reference}`;

        const response = await axios.get(url);

        const raw = response.data;

        const finalStatus =
          mapNelloStatus(raw);

        await db.begin(async (sql) => {
          await sql`
            UPDATE transactions
            SET
              status = ${finalStatus},
              api_response = ${JSON.stringify(raw)}
            WHERE reference = ${tx.reference}
          `;

          if (
            raw.status ===
              "INSUFFICIENT_BALANCE" ||
            ["failed", "cancelled"].includes(
              finalStatus
            )
          ) {
            const [user] = await sql`
              SELECT balance
              FROM users
              WHERE id = ${req.user.id}
            `;

            const newBalance =
              Number(user.balance) +
              Number(tx.amount);

            await sql`
              UPDATE users
              SET balance = ${newBalance}
              WHERE id = ${req.user.id}
            `;
          }
        });
      } catch (errTx) {
        console.error(
          `❌ Failed to sync transaction ${tx.reference}:`,
          errTx.message
        );
      }
    }

    res.json({
      success: true,
      updated: pendingTx.length,
    });
  } catch (err) {
    console.error("❌ SYNC ERROR:", err);

    res.status(500).json({
      error: err.message,
    });
  }
});

module.exports = router;