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

    // Accept either friendly name or numeric code
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

    // EA response content
    const content = response.data?.message?.content || {};

    return res.json({
      success: true,
      data: content,
      raw: response.data,
    });
  } catch (error) {
    console.error("❌ EasyAccess VERIFY error:", error.response?.data || error.message);
    return res.status(500).json({ success: false, message: "Failed to verify TV subscription" });
  }
});

// ---------- BUY TV ----------
router.post("/buy", async (req, res) => {
  let connection;
  try {
    const { user_id, company: rawCompany, iucno, packageId } = req.body;
    if (!user_id || !rawCompany || !iucno || !packageId) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const companyCode = (COMPANY_CODES[rawCompany.toLowerCase()] || rawCompany).toString();

    connection = await db.getConnection();

    // Get custom price
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

    // Start DB transaction: lock user row, check balance, deduct
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
    await connection.execute("UPDATE users SET balance = ? WHERE id = ?", [balanceAfter, user_id]);

    // Insert pending transaction
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

    await connection.commit();

    // Call EasyAccess
    const form = new FormData();
    form.append("company", companyCode);
    form.append("iucno", iucno);
    form.append("package", packageId);
    form.append("max_amount_payable", maxAmountPayable.toString());
    if (WEBHOOK_URL) form.append("webhook_url", WEBHOOK_URL);

    console.log(`\n➡️ Sending EASYACCESS PAY request [${client_reference}]`);

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
      // Refund handling...
      await handleRefund(connection, user_id, maxAmountPayable, txReference, eaErr.response?.data || eaErr.message);
      return res.status(500).json({ success: false, message: "Provider request failed, amount refunded" });
    }

    // Process EA response
    const isSuccess = ["true", "success", "200", true].includes(eaResponse?.success);
    const apiAmount = eaResponse?.amount || 0;

    await connection.execute(
      `UPDATE transactions SET status=?, api_amount=?, description=CONCAT(IFNULL(description,''), ?) WHERE reference=?`,
      [isSuccess ? "success" : "failed", apiAmount, JSON.stringify({ easyaccess_response: eaResponse }), txReference]
    );

    if (!isSuccess) {
      await handleRefund(connection, user_id, maxAmountPayable, txReference, "EA purchase failed");
    }

    const [finalBalanceRows] = await connection.execute("SELECT balance FROM users WHERE id = ?", [user_id]);
    const finalBalance = Number(finalBalanceRows[0].balance || 0);
    await connection.execute("UPDATE transactions SET balance_after=? WHERE reference=?", [finalBalance, txReference]);

    connection.release();
    return res.json({ success: true, data: { provider: eaResponse, reference: txReference, status: isSuccess ? "success" : "failed" } });

  } catch (error) {
    console.error("❌ BUY flow error:", error.response?.data || error.message || error);
    try { if (connection) await connection.rollback(); } catch (_) {}
    try { if (connection) connection.release(); } catch (_) {}
    return res.status(500).json({ success: false, message: "Purchase failed" });
  }
});

// ---------- Helper: Refund user ----------
async function handleRefund(connection, user_id, amount, txReference, errorMsg) {
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE transactions SET status=?, description=CONCAT(IFNULL(description,''), ?) WHERE reference=?`,
      ["failed", JSON.stringify({ provider_error: errorMsg, refund: true }), txReference]
    );

    const [uRows] = await connection.execute("SELECT balance FROM users WHERE id = ? FOR UPDATE", [user_id]);
    const currentBalance = Number(uRows[0].balance || 0);
    const refundedBalance = +(currentBalance + amount).toFixed(2);

    await connection.execute("UPDATE users SET balance=? WHERE id=?", [refundedBalance, user_id]);
    await connection.execute(
      `UPDATE transactions SET balance_after=? WHERE reference=?`,
      [refundedBalance, txReference]
    );

    await connection.commit();
  } catch (refundErr) {
    console.error("❌ Error during refund handling:", refundErr);
    try { await connection.rollback(); } catch (_) {}
  }
}

module.exports = router;
