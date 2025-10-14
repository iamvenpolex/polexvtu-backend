// routes/buycabletv.js
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const router = express.Router();
const db = require("../config/db"); // mysql2/promise pool

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""; // optional

// Map friendly company names to EasyAccess company codes
const COMPANY_CODES = {
  dstv: "01",
  gotv: "02",
  startimes: "03",
  showmax: "04",
};

function makeClientRef() {
  return `ref_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

/**
 * GET /status/:reference
 * Returns transaction status and provider response (if any)
 */
router.get("/status/:reference", async (req, res) => {
  const { reference } = req.params;
  if (!reference) return res.status(400).json({ success: false, message: "Missing reference" });

  try {
    const [rows] = await db.execute("SELECT * FROM transactions WHERE reference = ? LIMIT 1", [reference]);
    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: "Transaction not found" });

    const tx = rows[0];

    // Try to parse any provider info from description if present
    let provider = null;
    try {
      if (tx.description) {
        // description is JSON fragments concatenated in code; attempt to find easyaccess_response
        const text = tx.description;
        const idx = text.indexOf('"easyaccess_response":');
        if (idx !== -1) {
          // crude parse: get substring from that index to end, then fix braces
          const sub = text.slice(idx + 22);
          // attempt JSON.parse on trailing braces if possible
          const firstBrace = sub.indexOf("{");
          const lastBrace = sub.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace !== -1) {
            const jsonStr = sub.slice(firstBrace, lastBrace + 1);
            provider = JSON.parse(jsonStr);
          }
        }
      }
    } catch (e) {
      // ignore parse errors
    }

    return res.json({
      success: true,
      status: tx.status,
      amount: tx.amount,
      reference: tx.reference,
      api_amount: tx.api_amount,
      provider,
      raw: tx,
    });
  } catch (err) {
    console.error("Status lookup error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch status" });
  }
});

/**
 * POST /buy
 * Body: { user_id, company (dstv/gotv/startimes/showmax OR numeric), iucno, packageId }
 *
 * Flow:
 *  - Deduct wallet immediately
 *  - Insert transaction with status = "processing"
 *  - RETURN to frontend: { success: true, status: "processing", reference }
 *  - In background: call EasyAccess paytv.php, update transaction status to success/failed, auto-refund if failed
 */
router.post("/buy", async (req, res) => {
  const { user_id, company: rawCompany, iucno, packageId } = req.body;
  if (!user_id || !rawCompany || !iucno || !packageId) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  // companyCode (numeric) for EasyAccess; rawCompany is used to query custom_cabletv_prices (e.g., 'dstv')
  const companyCode = (COMPANY_CODES[rawCompany.toLowerCase()] || rawCompany).toString();

  let connection;
  try {
    connection = await db.getConnection();

    // 1) fetch custom price (from your table which stores company_code like 'dstv')
    const [rows] = await connection.execute(
      `SELECT custom_price FROM custom_cabletv_prices WHERE company_code=? AND package_code=? AND status='active' LIMIT 1`,
      [rawCompany, packageId]
    );

    const customRow = rows[0];
    if (!customRow || customRow.custom_price == null) {
      connection.release();
      return res.status(400).json({ success: false, message: "Custom price not set by admin" });
    }
    const amount = Number(customRow.custom_price);

    // 2) BEGIN transaction: lock user and deduct
    await connection.beginTransaction();

    const [urows] = await connection.execute("SELECT id, balance FROM users WHERE id = ? FOR UPDATE", [user_id]);
    if (!urows || urows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = urows[0];
    const balanceBefore = Number(user.balance || 0);
    if (balanceBefore < amount) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: "Insufficient wallet balance" });
    }

    const balanceAfter = +(balanceBefore - amount).toFixed(2);
    await connection.execute("UPDATE users SET balance = ? WHERE id = ?", [balanceAfter, user_id]);

    // 3) insert transaction with status = processing
    const client_reference = makeClientRef();
    const insertQuery = `
      INSERT INTO transactions
        (user_id, reference, type, amount, status, api_amount, network, plan, phone, via, description, balance_before, balance_after, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    const desc = JSON.stringify({
      note: "Initiated cable purchase - processing",
      company: rawCompany,
      packageId,
      client_reference,
      amount,
    });

    await connection.execute(insertQuery, [
      user_id,
      client_reference,
      "cabletv",
      amount,
      "processing",
      0.0,
      companyCode,
      packageId,
      iucno,
      "wallet",
      desc,
      balanceBefore,
      balanceAfter,
    ]);

    // commit so frontend sees processing and wallet has been deducted
    await connection.commit();
    connection.release();

    // IMMEDIATE RESPONSE: processing
    res.json({ success: true, status: "processing", reference: client_reference });

    // --- BACKGROUND WORKER: call EasyAccess and update DB ---
    (async () => {
      let bgConn;
      try {
        bgConn = await db.getConnection();

        // call EasyAccess paytv.php
        const form = new FormData();
        form.append("company", companyCode);
        form.append("iucno", iucno);
        form.append("package", packageId);
        form.append("max_amount_payable", amount.toString());
        if (WEBHOOK_URL) form.append("webhook_url", WEBHOOK_URL);

        console.log(`\n➡️ [BG ${client_reference}] sending to EasyAccess: company=${companyCode}, iucno=${iucno}, package=${packageId}, amount=${amount}`);

        let eaResp;
        try {
          const response = await axios.post(`${BASE_URL}/paytv.php`, form, {
            headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...form.getHeaders() },
            timeout: 60_000,
          });
          eaResp = response.data;
          console.log(`✅ [BG ${client_reference}] EasyAccess response:`, eaResp);
        } catch (eaErr) {
          console.error(`❌ [BG ${client_reference}] EasyAccess network/error:`, eaErr.response?.data || eaErr.message);

          // Mark tx failed and attempt refund
          try {
            await bgConn.beginTransaction();

            await bgConn.execute(
              `UPDATE transactions SET status = ?, description = CONCAT(IFNULL(description, ''), ?), updated_at = NOW() WHERE reference = ?`,
              ["failed", JSON.stringify({ provider_error: eaErr.response?.data || eaErr.message }), client_reference]
            );

            // refund wallet
            const [bRows] = await bgConn.execute("SELECT balance FROM users WHERE id = ? FOR UPDATE", [user_id]);
            const currentBal = Number(bRows[0].balance || 0);
            const refunded = +(currentBal + amount).toFixed(2);
            await bgConn.execute("UPDATE users SET balance = ? WHERE id = ?", [refunded, user_id]);

            await bgConn.execute(
              `UPDATE transactions SET balance_after = ?, description = CONCAT(IFNULL(description, ''), ?) WHERE reference = ?`,
              [refunded, JSON.stringify({ refund: true }), client_reference]
            );

            await bgConn.commit();
          } catch (refErr) {
            console.error(`[BG ${client_reference}] error during refund:`, refErr);
            try { await bgConn.rollback(); } catch (_) {}
          } finally {
            try { bgConn.release(); } catch (_) {}
          }
          return;
        }

        // Process eaResp
        try {
          const eaStatusRaw = eaResp?.success;
          const successValues = ["true", "success", "200", true];
          const isSuccess = successValues.includes(eaStatusRaw);

          const apiAmount = eaResp?.amount || 0;
          const txStatus = isSuccess ? "success" : "failed";

          await bgConn.beginTransaction();

          await bgConn.execute(
            `UPDATE transactions SET status = ?, api_amount = ?, description = CONCAT(IFNULL(description, ''), ?), updated_at = NOW() WHERE reference = ?`,
            [txStatus, apiAmount, JSON.stringify({ easyaccess_response: eaResp }), client_reference]
          );

          if (!isSuccess) {
            // auto-refund
            const [bRows2] = await bgConn.execute("SELECT balance FROM users WHERE id = ? FOR UPDATE", [user_id]);
            const currentBal2 = Number(bRows2[0].balance || 0);
            const newBal = +(currentBal2 + amount).toFixed(2);
            await bgConn.execute("UPDATE users SET balance = ? WHERE id = ?", [newBal, user_id]);

            await bgConn.execute(
              `UPDATE transactions SET balance_after = ?, description = CONCAT(IFNULL(description, ''), ?) WHERE reference = ?`,
              [newBal, JSON.stringify({ auto_refund_attempted: true }), client_reference]
            );
          } else {
            // success -> leave balance after as is
            const [fb] = await bgConn.execute("SELECT balance FROM users WHERE id = ? LIMIT 1", [user_id]);
            const finalBal = Number(fb[0].balance || 0);
            await bgConn.execute(`UPDATE transactions SET balance_after = ? WHERE reference = ?`, [finalBal, client_reference]);
          }

          await bgConn.commit();
          bgConn.release();
          console.log(`[BG ${client_reference}] transaction updated to ${txStatus}`);
        } catch (procErr) {
          console.error(`[BG ${client_reference}] error processing provider response:`, procErr);
          try { await bgConn.rollback(); } catch (_) {}
          try { bgConn.release(); } catch (_) {}
        }
      } catch (bgErr) {
        console.error(`[BG ${client_reference}] background DB error:`, bgErr);
        try { if (bgConn) bgConn.release(); } catch (_) {}
      }
    })(); // end background immediately-invoked async
  } catch (err) {
    console.error("Buy endpoint error:", err);
    try { if (connection) await connection.rollback(); } catch (_) {}
    try { if (connection) connection.release(); } catch (_) {}
    return res.status(500).json({ success: false, message: "Purchase failed" });
  }
});

module.exports = router;
