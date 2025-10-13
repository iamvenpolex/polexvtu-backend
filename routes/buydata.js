// routes/buydata.js
"use strict";

const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const { protect } = require("../middleware/authMiddleware");
const router = express.Router();

const EA_BASE = "https://easyaccessapi.com.ng/api";
const EA_DATA_ENDPOINT = `${EA_BASE}/data.php`;
const API_TOKEN = process.env.EASY_ACCESS_TOKEN;
const WEBHOOK_URL = process.env.EA_WEBHOOK_URL || `${process.env.BACKEND_URL}/api/buydata/webhook`;

/**
 * POST /api/buydata
 * Protected route
 * Body: { network, mobile_no, dataplan, client_reference }
 *
 * Pricing model: use custom_price if set; otherwise use EA price
 */
router.post("/", protect, async (req, res) => {
  console.log("📩 Incoming Buy Data Request:", req.body);
  const { network, mobile_no, dataplan, client_reference } = req.body;
  const user_id = req.user?.id;

  if (!user_id || !network || !mobile_no || !dataplan || !client_reference) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }
  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({ success: false, message: "Mobile number must be 11 digits" });
  }

  try {
    // 1) fetch user
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ? LIMIT 1", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    // 2) fetch plan from DB
    const [planRows] = await db.query(
      "SELECT product_type, plan_id, plan_name, api_price, custom_price, status FROM custom_data_prices WHERE plan_id = ? LIMIT 1",
      [dataplan]
    );
    if (!planRows.length) return res.status(400).json({ success: false, message: "Plan not available in DB" });
    const plan = planRows[0];
    if (plan.status !== "active") return res.status(400).json({ success: false, message: "Plan is inactive" });

    // 3) idempotency check
    const [existingTx] = await db.query("SELECT id, status FROM transactions WHERE reference = ? LIMIT 1", [client_reference]);
    if (existingTx.length) {
      return res.status(409).json({ success: false, message: "Reference already processed", reference: client_reference });
    }

    // 4) fetch EA price for the dataplan (EA get_plans.php?product_type=data) and find plan
    const eaRes = await axios.get(`${EA_BASE}/get_plans.php?product_type=data`, { headers: { AuthorizationToken: API_TOKEN }, timeout: 15000 });
    const allEa = [...(eaRes.data?.MTN || []), ...(eaRes.data?.GLO || []), ...(eaRes.data?.AIRTEL || []), ...(eaRes.data?.ETISALAT || [])];
    const eaPlan = allEa.find((p) => String(p.plan_id) === String(dataplan));
    if (!eaPlan) {
      // disable plan in DB to avoid future attempts
      await db.query("UPDATE custom_data_prices SET status = 'inactive' WHERE plan_id = ? AND product_type = ?", [dataplan, plan.product_type]);
      return res.status(400).json({ success: false, message: "Plan not found on EasyAccess. We've disabled it in the admin list." });
    }
    const eaPrice = Number(eaPlan.price ?? eaPlan.amount ?? 0);

    // 5) Determine charge amount using pricing model B
    const chargeAmount = plan.custom_price != null ? Number(plan.custom_price) : eaPrice;

    // 6) check user balance
    if (Number(user.balance) < chargeAmount) {
      return res.status(400).json({ success: false, message: "Insufficient balance", user_balance: user.balance });
    }

    // 7) Deduct user wallet
    const balance_before = Number(user.balance);
    const balance_after = balance_before - chargeAmount;
    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    // 8) Insert transaction (pending)
    await db.query(
      `INSERT INTO transactions (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        user.id,
        client_reference,
        "data",
        chargeAmount,
        0,
        "pending",
        network,
        plan.plan_name,
        mobile_no,
        "wallet",
        `Data purchase of ${plan.plan_name} via wallet`,
        balance_before,
        balance_after,
      ]
    );

    // 9) Send request to EA with eaPrice as max_amount_payable
    const params = new URLSearchParams();
    params.append("network", network);
    params.append("mobileno", mobile_no);
    params.append("dataplan", dataplan);
    params.append("client_reference", client_reference);
    params.append("max_amount_payable", eaPrice.toString());
    params.append("webhook_url", WEBHOOK_URL);

    const eaPost = await axios.post(EA_DATA_ENDPOINT, params.toString(), {
      headers: { AuthorizationToken: API_TOKEN, "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    // 10) Update api_amount if EA returned
    if (eaPost.data?.amount) {
      await db.query("UPDATE transactions SET api_amount = ? WHERE reference = ?", [Number(eaPost.data.amount), client_reference]);
    }

    // 11) If EA immediately reports failed and auto_refund_status is processed/failed, handle refund now
    // (but prefer webhook — webhook will also handle it)
    if (String(eaPost.data?.success ?? "").toLowerCase().startsWith("false")) {
      const autoRefund = eaPost.data?.auto_refund_status;
      if (autoRefund && String(autoRefund).toLowerCase() === "processed" || String(autoRefund).toLowerCase() === "failed") {
        // Refund user (idempotent not strictly checked here because we just inserted transaction)
        // Update transaction status and api_amount and credit wallet
        await db.query("UPDATE transactions SET status = ?, api_amount = ? WHERE reference = ?", ["failed", Number(eaPost.data.amount ?? 0), client_reference]);

        // Credit user back
        const [uRows] = await db.query("SELECT balance FROM users WHERE id = ? LIMIT 1", [user.id]);
        if (uRows.length) {
          const newBal = Number(uRows[0].balance) + Number(chargeAmount);
          await db.query("UPDATE users SET balance = ? WHERE id = ?", [newBal, user.id]);
          // insert refund transaction row
          const refundRef = `refund_${client_reference}_${Date.now()}`;
          await db.query(
            `INSERT INTO transactions (user_id, reference, type, amount, api_amount, status, via, description, balance_before, balance_after, created_at)
             VALUES (?, ?, 'refund', ?, ?, 'success', 'auto_refund', ?, ?, ?, NOW())`,
            [user.id, refundRef, chargeAmount, Number(eaPost.data?.amount ?? 0), `Auto refund for ${client_reference}`, Number(uRows[0].balance), newBal]
          );
        }
      }
    }

    return res.json({
      success: true,
      message: "Purchase initiated. Awaiting EasyAccess webhook confirmation.",
      reference: client_reference,
      user_id: user.id,
      amount: chargeAmount,
      network,
      phone: mobile_no,
      plan: plan.plan_name,
      status: "pending",
      api_response: eaPost.data,
    });
  } catch (err) {
    console.error("buydata error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ success: false, message: "Error purchasing data", error: err?.response?.data || err?.message });
  }
});

/**
 * POST /api/buydata/webhook
 * EasyAccess will POST transaction updates here. Format varies; we try to parse known fields.
 */
router.post("/webhook", express.json(), async (req, res) => {
  try {
    const payload = req.body;
    const ref = payload.client_reference || payload.clientReference || payload.client_reference_id || payload.reference;
    if (!ref) return res.status(400).send("missing reference");

    // find existing transaction
    const [txRows] = await db.query("SELECT id, user_id, amount, status FROM transactions WHERE reference = ? LIMIT 1", [ref]);
    if (!txRows.length) {
      console.warn("webhook: transaction not found for reference", ref);
      return res.status(404).send("tx not found");
    }
    const tx = txRows[0];
    const prevStatus = tx.status;
    const txAmount = Number(tx.amount ?? 0);
    const userId = tx.user_id;

    // derive status
    let newStatus = "pending";
    const statusField = String(payload.status ?? payload.success ?? "").toLowerCase();
    if (statusField === "success" || statusField === "true") newStatus = "success";
    else if (statusField === "failed" || statusField === "false") {
      // check auto_refund_status if provided
      newStatus = payload.auto_refund_status && String(payload.auto_refund_status).toLowerCase() === "processed" ? "refunded" : "failed";
    }

    const apiAmount = payload.amount ? Number(payload.amount) : null;

    // Update transaction
    const updates = [];
    const params = [];
    updates.push("status = ?");
    params.push(newStatus);
    if (apiAmount != null) {
      updates.push("api_amount = ?");
      params.push(apiAmount);
    }
    updates.push("updated_at = NOW()");
    params.push(ref);
    await db.query(`UPDATE transactions SET ${updates.join(", ")} WHERE reference = ?`, params);

    // If refunded and previous status wasn't refunded — credit user (idempotent)
    const isRefunded = newStatus === "refunded" || newStatus === "failed" && String(payload.auto_refund_status ?? "").toLowerCase() === "failed";
    if (isRefunded && prevStatus !== "refunded") {
      // credit wallet
      const [userRows] = await db.query("SELECT id, balance FROM users WHERE id = ? LIMIT 1", [userId]);
      if (userRows.length) {
        const user = userRows[0];
        const newBalance = Number(user.balance) + txAmount;
        await db.query("UPDATE users SET balance = ? WHERE id = ?", [newBalance, userId]);

        // insert refund transaction row
        const refundRef = `refund_${ref}_${Date.now()}`;
        await db.query(
          `INSERT INTO transactions (user_id, reference, type, amount, api_amount, status, via, description, balance_before, balance_after, created_at)
           VALUES (?, ?, 'refund', ?, ?, 'success', 'auto_refund', ?, ?, ?, NOW())`,
          [userId, refundRef, txAmount, apiAmount ?? 0, `Auto refund for ${ref}`, Number(user.balance), newBalance]
        );
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("webhook handler error:", err);
    return res.status(500).send("Error");
  }
});

module.exports = router;
