// routes/buycabletv.js
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const router = express.Router();
const db = require("../config/db"); // mysql2/promise pool

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

// Map friendly company names to EasyAccess company codes
const COMPANY_CODES = {
  dstv: "01",
  gotv: "02",
  startimes: "03",
  showmax: "04",
};

// Helper to create a unique client reference
function makeClientRef() {
  return `ref_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

// ---------- VERIFY TV ----------
router.post("/verify", async (req, res) => {
  try {
    let { company, iucno } = req.body;
    if (!company || !iucno) {
      return res.status(400).json({ success: false, message: "Missing company or IUC number" });
    }

    // accept either friendly name or numeric code
    const companyCode = (COMPANY_CODES[company.toLowerCase()] || company).toString();

    const data = new FormData();
    data.append("company", companyCode);
    data.append("iucno", iucno);

    console.log(`\n➡️ Sending VERIFY request to EasyAccess: company=${companyCode}, iucno=${iucno}`);

    const response = await axios.post(`${BASE_URL}/verifytv.php`, data, {
      headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...data.getHeaders() },
      timeout: 30_000,
    });

    console.log(`✅ EasyAccess VERIFY response:`, response.data);

    // Normalize EA response (EA may return data in different shapes)
    const eaData = response.data?.data || response.data || {};
    const account_name = eaData.account_name || eaData.AccountName || "N/A";
    const status = eaData.status || eaData.Status || "N/A";

    return res.json({
      success: true,
      data: { account_name, status, raw: eaData },
    });
  } catch (error) {
    console.error("❌ EasyAccess VERIFY error:", error.response?.data || error.message);
    return res.status(500).json({ success: false, message: "Failed to verify TV subscription" });
  }
});

// ---------- BUY TV ----------
router.post("/buy", async (req, res) => {
  // Expected body: { user_id, company (name or numeric), iucno, packageId }
  let connection;
  try {
    const { user_id, company: rawCompany, iucno, packageId } = req.body;
    if (!user_id || !rawCompany || !iucno || !packageId) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const companyCode = (COMPANY_CODES[rawCompany.toLowerCase()] || rawCompany).toString();

    // get connection for transaction
    connection = await db.getConnection();

    // 1) Read custom price (use the stored company code string from your table like 'dstv')
    // NOTE: your custom_cabletv_prices uses company_code like 'dstv' (not numeric),
    // so we query using rawCompany if that's how you stored it. Adjust if you stored numeric codes.
    const [rows] = await connection.execute(
      `SELECT custom_price FROM custom_cabletv_prices WHERE company_code=? AND package_code=? AND status='active' LIMIT 1`,
      [rawCompany, packageId]
    );

    const customRow = rows[0];
    if (!customRow || customRow.custom_price == null) {
      connection.release();
      return res.status(400).json({ success: false, message: "Custom price not set by admin" });
    }

    const maxAmountPayable = Number(customRow.custom_price);

    // 2) Start DB transaction, lock user row, check balance, deduct
    await connection.beginTransaction();

    const [userRows] = await connection.execute("SELECT id, balance FROM users WHERE id = ? FOR UPDATE", [user_id]);
    if (!userRows || userRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = userRows[0];
    const balanceBefore = Number(user.balance || 0);

    if (balanceBefore < maxAmountPayable) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: "Insufficient wallet balance" });
    }

    const balanceAfter = +(balanceBefore - maxAmountPayable).toFixed(2);

    // Update user balance
    await connection.execute("UPDATE users SET balance = ? WHERE id = ?", [balanceAfter, user_id]);

    // Insert a pending transaction
    const client_reference = makeClientRef();
    const txReference = client_reference;

    const insertTxQuery = `
      INSERT INTO transactions
        (user_id, reference, type, amount, status, api_amount, network, plan, phone, via, description, balance_before, balance_after, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;

    const descriptionInitial = JSON.stringify({
      note: "Initiated cable TV purchase (pending EasyAccess)",
      company: rawCompany,
      packageId,
      client_reference,
      maxAmountPayable,
    });

    await connection.execute(insertTxQuery, [
      user_id,
      txReference,
      "cabletv",
      maxAmountPayable,
      "pending",
      0.0,
      companyCode,
      packageId,
      iucno,
      "wallet",
      descriptionInitial,
      balanceBefore,
      balanceAfter,
    ]);

    // commit so wallet deduction + pending tx are saved before external call
    await connection.commit();

    // 3) Call EasyAccess
    const form = new FormData();
    form.append("company", companyCode);
    form.append("iucno", iucno);
    form.append("package", packageId);
    form.append("max_amount_payable", maxAmountPayable.toString());
    if (WEBHOOK_URL) form.append("webhook_url", WEBHOOK_URL);

    console.log(`\n➡️ Sending EASYACCESS PAY request [${client_reference}]: company=${companyCode}, iucno=${iucno}, package=${packageId}, max_amount_payable=${maxAmountPayable}`);

    let eaResponse;
    try {
      const response = await axios.post(`${BASE_URL}/paytv.php`, form, {
        headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...form.getHeaders() },
        timeout: 60_000,
      });
      eaResponse = response.data;
      console.log(`✅ EasyAccess BUY response [${client_reference}]:`, eaResponse);
    } catch (eaErr) {
      console.error(`❌ EasyAccess BUY request error [${client_reference}]:`, eaErr.response?.data || eaErr.message);

      // Attempt refund handling (we already deducted)
      try {
        await connection.beginTransaction();

        // Update transaction status and append provider error
        await connection.execute(
          `UPDATE transactions SET status = ?, description = CONCAT(IFNULL(description, ''), ?), updated_at = NOW() WHERE reference = ?`,
          ["failed", JSON.stringify({ provider_error: eaErr.response?.data || eaErr.message }), txReference]
        );

        // refund user (add back)
        const [uRows2] = await connection.execute("SELECT balance FROM users WHERE id = ? FOR UPDATE", [user_id]);
        const currentBalance = Number(uRows2[0].balance || 0);
        const refundedBalance = +(currentBalance + maxAmountPayable).toFixed(2);

        await connection.execute("UPDATE users SET balance = ? WHERE id = ?", [refundedBalance, user_id]);

        // update transaction balance_after and description to note refund
        await connection.execute(
          `UPDATE transactions SET balance_after = ?, description = CONCAT(IFNULL(description, ''), ?) WHERE reference = ?`,
          [refundedBalance, JSON.stringify({ refund: true }), txReference]
        );

        await connection.commit();
      } catch (rollbackErr) {
        console.error("❌ Error during refund handling:", rollbackErr.response?.data || rollbackErr.message || rollbackErr);
        try { await connection.rollback(); } catch (_) {}
      } finally {
        connection.release();
      }

      return res.status(500).json({ success: false, message: "Provider request failed, amount refunded" });
    }

    // 4) Process EA response and update transaction + optionally refund if failed
    try {
      const eaStatusRaw = eaResponse?.success;
      const successValues = ["true", "success", "200", true];
      const isSuccess = successValues.includes(eaStatusRaw);

      const apiAmount = eaResponse?.amount || 0;
      const txStatus = isSuccess ? "success" : "failed";

      await connection.execute(
        `UPDATE transactions SET status = ?, api_amount = ?, description = CONCAT(IFNULL(description, ''), ?), updated_at = NOW() WHERE reference = ?`,
        [txStatus, apiAmount, JSON.stringify({ easyaccess_response: eaResponse }), txReference]
      );

      // If EA indicates failure, refund immediately
      if (!isSuccess) {
        await connection.beginTransaction();

        const [uRows3] = await connection.execute("SELECT balance FROM users WHERE id = ? FOR UPDATE", [user_id]);
        const currentBalance2 = Number(uRows3[0].balance || 0);
        const newBalanceAfterRefund = +(currentBalance2 + maxAmountPayable).toFixed(2);

        await connection.execute("UPDATE users SET balance = ? WHERE id = ?", [newBalanceAfterRefund, user_id]);

        await connection.execute(
          `UPDATE transactions SET balance_after = ?, description = CONCAT(IFNULL(description, ''), ?) WHERE reference = ?`,
          [newBalanceAfterRefund, JSON.stringify({ auto_refund_attempted: true }), txReference]
        );

        await connection.commit();
      }

      // update final balance_after in transactions
      const [finalBalanceRows] = await connection.execute("SELECT balance FROM users WHERE id = ?", [user_id]);
      const finalBalance = Number(finalBalanceRows[0].balance || 0);

      await connection.execute(`UPDATE transactions SET balance_after = ? WHERE reference = ?`, [finalBalance, txReference]);

      connection.release();
      return res.json({ success: true, data: { provider: eaResponse, reference: txReference, status: isSuccess ? "success" : "failed" } });
    } catch (updateErr) {
      console.error("❌ Error updating transaction after EA response:", updateErr.response?.data || updateErr.message || updateErr);
      try { await connection.rollback(); } catch (_) {}
      connection.release();
      return res.status(500).json({ success: false, message: "Failed to update transaction after provider response" });
    }
  } catch (error) {
    console.error("❌ BUY flow error:", error.response?.data || error.message || error);
    try { if (connection) await connection.rollback(); } catch (_) {}
    try { if (connection) connection.release(); } catch (_) {}
    return res.status(500).json({ success: false, message: "Purchase failed" });
  }
});

module.exports = router;
