// routes/buycabletv.js
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const router = express.Router();
const db = require("../config/db"); // postgres.js

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = "https://easyaccessapi.com.ng/api";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

// Company mapping
const COMPANY_CODES = {
  dstv: "01",
  gotv: "02",
  startimes: "03",
  showmax: "04",
};

// Unique reference generator
function makeClientRef() {
  return `ref_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

// ----------------------------
// Verify TV subscription
// ----------------------------
router.post("/verify", async (req, res) => {
  try {
    const { company, iucno } = req.body;
    if (!company || !iucno) {
      return res.status(400).json({ success: false, message: "Missing company or IUC number" });
    }

    const companyCode = (COMPANY_CODES[company.toLowerCase()] || company).toString();
    const form = new FormData();
    form.append("company", companyCode);
    form.append("iucno", iucno);

    const response = await axios.post(`${BASE_URL}/verifytv.php`, form, {
      headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...form.getHeaders() },
      timeout: 30000,
    });

    // Log full response
    console.log("📡 VERIFY response:", JSON.stringify(response.data, null, 2));

    return res.json({
      success: response.data?.success === "true" || response.data?.success === true,
      data: response.data?.message?.content || {},
      raw: response.data,
    });
  } catch (error) {
    console.error("❌ VERIFY error:", error.response?.data || error.message);
    return res.status(500).json({ success: false, message: "Failed to verify TV subscription" });
  }
});

// ----------------------------
// Buy TV subscription
// ----------------------------
router.post("/buy", async (req, res) => {
  try {
    const { user_id, company: rawCompany, iucno, packageId } = req.body;
    if (!user_id || !rawCompany || !iucno || !packageId) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const companyCode = (COMPANY_CODES[rawCompany.toLowerCase()] || rawCompany).toString();

    // Fetch custom price
    const customRows = await db`
      SELECT custom_price
      FROM custom_cabletv_prices
      WHERE company_code = ${rawCompany} AND package_code = ${packageId} AND status = 'active'
      LIMIT 1
    `;

    if (!customRows.length || customRows[0].custom_price == null) {
      return res.status(400).json({ success: false, message: "Custom price not set by admin" });
    }

    const maxAmountPayable = Number(customRows[0].custom_price);
    const txReference = makeClientRef();
    let eaResponse;

    await db.transaction(async (sql) => {
      // Lock user row for safe wallet deduction
      const userRows = await sql`
        SELECT id, balance FROM users WHERE id = ${user_id} FOR UPDATE
      `;
      if (!userRows.length) throw new Error("User not found");

      const user = userRows[0];
      const balanceBefore = Number(user.balance || 0);

      if (balanceBefore < maxAmountPayable) throw new Error("Insufficient wallet balance");

      const balanceAfter = +(balanceBefore - maxAmountPayable).toFixed(2);

      // Deduct wallet
      await sql`UPDATE users SET balance = ${balanceAfter} WHERE id = ${user_id}`;

      // Insert pending transaction
      const descriptionInitial = JSON.stringify({
        note: "Initiated cable TV purchase (pending EasyAccess)",
        company: rawCompany,
        packageId,
        client_reference: txReference,
        maxAmountPayable,
      });

      await sql`
        INSERT INTO transactions (
          user_id, reference, type, amount, status, api_amount,
          network, plan, phone, via, description,
          balance_before, balance_after, created_at
        )
        VALUES (
          ${user_id}, ${txReference}, 'cabletv', ${maxAmountPayable}, 'pending', 0,
          ${companyCode}, ${packageId}, ${iucno}, 'wallet',
          ${descriptionInitial}, ${balanceBefore}, ${balanceAfter}, NOW()
        )
      `;

      // Call EasyAccess API
      const form = new FormData();
      form.append("company", companyCode);
      form.append("iucno", iucno);
      form.append("package", packageId);
      form.append("max_amount_payable", maxAmountPayable.toString());
      if (WEBHOOK_URL) form.append("webhook_url", WEBHOOK_URL);

      try {
        const response = await axios.post(`${BASE_URL}/paytv.php`, form, {
          headers: { AuthorizationToken: EASY_ACCESS_TOKEN, ...form.getHeaders() },
          timeout: 60000,
        });
        eaResponse = response.data;

        // Log full EasyAccess response
        console.log("📡 EasyAccess API response:", JSON.stringify(eaResponse, null, 2));
      } catch (eaErr) {
        await refund(sql, user_id, maxAmountPayable, txReference, eaErr.response?.data || eaErr.message);
        throw new Error("Provider request failed, refunded");
      }

      // Update transaction based on API response
      const isSuccess = ["true", "success", "200", true].includes(eaResponse?.success);
      const apiAmount = eaResponse?.amount || 0;

      await sql`
        UPDATE transactions
        SET status = ${isSuccess ? "success" : "failed"},
            api_amount = ${apiAmount},
            description = description || ${JSON.stringify({ easyaccess_response: eaResponse })}
        WHERE reference = ${txReference}
      `;

      if (!isSuccess) {
        await refund(sql, user_id, maxAmountPayable, txReference, "EA purchase failed");
      }

      // Update final balance_after
      const finalBal = await sql`SELECT balance FROM users WHERE id = ${user_id}`;
      await sql`UPDATE transactions SET balance_after = ${finalBal[0].balance} WHERE reference = ${txReference}`;

      // Log final transaction state
      console.log(`✅ Transaction ${txReference} updated with final status: ${isSuccess ? "success" : "failed"}`);
    });

    return res.json({
      success: true,
      data: { provider: eaResponse, reference: txReference },
    });
  } catch (err) {
    console.error("❌ BUY error:", err.message);
    return res.status(500).json({ success: false, message: err.message || "Purchase failed" });
  }
});

// ----------------------------
// Refund helper
// ----------------------------
async function refund(sql, user_id, amount, txReference, errorMsg) {
  // Mark transaction failed
  await sql`
    UPDATE transactions
    SET status='failed',
        description = description || ${JSON.stringify({ provider_error: errorMsg, refund: true })}
    WHERE reference = ${txReference}
  `;

  // Refund wallet
  const uRows = await sql`SELECT balance FROM users WHERE id = ${user_id} FOR UPDATE`;
  const refundedBalance = Number(uRows[0].balance) + Number(amount);

  await sql`UPDATE users SET balance = ${refundedBalance} WHERE id = ${user_id}`;
  await sql`UPDATE transactions SET balance_after=${refundedBalance} WHERE reference=${txReference}`;

  // Log refund
  console.log(`🔄 Transaction ${txReference} refunded: +${amount} to user ${user_id}`);
}

module.exports = router;
