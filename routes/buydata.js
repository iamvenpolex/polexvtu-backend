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
const WEBHOOK_URL = process.env.EA_WEBHOOK_URL || "https://polexvtu-backend-production.up.railway.app/api/buydata/webhook";

/**
 * POST /api/buydata
 * Body: { network, mobile_no, dataplan, client_reference }
 * Protected
 */
router.post("/", protect, async (req, res) => {
  const { network, mobile_no, dataplan, client_reference } = req.body;
  const user_id = req.user?.id;

  if (!user_id || !network || !mobile_no || !dataplan || !client_reference) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }
  if (!/^\d{11}$/.test(mobile_no)) {
    return res.status(400).json({ success: false, message: "Mobile number must be 11 digits" });
  }

  try {
    // fetch user
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ? LIMIT 1", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    // fetch plan from DB
    const [planRows] = await db.query(
      "SELECT product_type, plan_id, plan_name, custom_price, status FROM custom_data_prices WHERE plan_id = ? LIMIT 1",
      [dataplan]
    );
    if (!planRows.length) return res.status(400).json({ success: false, message: "Plan not available in DB" });
    const plan = planRows[0];
    if (plan.status !== "active") return res.status(400).json({ success: false, message: "Plan is inactive" });

    const customPrice = Number(plan.custom_price ?? 0);

    // idempotency: check existing transaction with same reference
    const [existingTx] = await db.query("SELECT id, status FROM transactions WHERE reference = ? LIMIT 1", [client_reference]);
    if (existingTx.length) {
      return res.status(409).json({ success: false, message: "Reference already processed", reference: client_reference });
    }

    // verify plan exists on EasyAccess (fetch EA data plans and find)
    const eaRes = await axios.get(`${EA_BASE}/get_plans.php?product_type=data`, {
      headers: { AuthorizationToken: API_TOKEN },
      timeout: 15000,
    });
    const allEa = [...(eaRes.data?.MTN || []), ...(eaRes.data?.GLO || []), ...(eaRes.data?.AIRTEL || []), ...(eaRes.data?.ETISALAT || [])];
    const eaPlan = allEa.find((p) => String(p.plan_id) === String(dataplan));
    if (!eaPlan) {
      // mark DB plan inactive to avoid future attempts
      await db.query("UPDATE custom_data_prices SET status = 'inactive' WHERE plan_id = ? AND product_type = ?", [dataplan, plan.product_type]);
      return res.status(400).json({ success: false, message: "Plan not found on EasyAccess. We've disabled it in the admin list." });
    }
    const eaPrice = Number(eaPlan.amount ?? eaPlan.price ?? 0);

    // check user balance
    if (Number(user.balance) < customPrice) {
      return res.status(400).json({ success: false, message: "Insufficient balance", user_balance: user.balance });
    }

    // deduct wallet (idempotent because we checked transaction above)
    const balance_before = Number(user.balance);
    const balance_after = balance_before - customPrice;
    await db.query("UPDATE users SET balance = ? WHERE id = ?", [balance_after, user.id]);

    // insert transaction
    await db.query(
      `INSERT INTO transactions (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        user.id,
        client_reference,
        "data",
        customPrice,
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

    // call EA with eaPrice as max_amount_payable
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

    // update api_amount if returned
    if (eaPost.data?.amount) {
      await db.query("UPDATE transactions SET api_amount = ? WHERE reference = ?", [Number(eaPost.data.amount), client_reference]);
    }

    return res.json({
      success: true,
      message: "Purchase initiated. Awaiting EasyAccess webhook confirmation.",
      reference: client_reference,
      user_id: user.id,
      amount: customPrice,
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
 * EA webhook handler - updates transactions status + api_amount.
 * If EA indicates a refund was processed, credit the user's wallet (idempotent).
 */
router.post("/webhook", express.json(), async (req, res) => {
  try {
    const payload = req.body;
    const ref = payload.client_reference || payload.clientReference || payload.reference;
    if (!ref) return res.status(400).send("missing reference");

    // fetch existing transaction (we need its current status & amount & user_id)
    const [txRows] = await db.query("SELECT id, user_id, amount, status FROM transactions WHERE reference = ? LIMIT 1", [ref]);
    if (!txRows.length) {
      console.warn("webhook: transaction not found for reference", ref);
      return res.status(404).send("tx not found");
    }
    const tx = txRows[0];
    const prevStatus = tx.status;
    const txAmount = Number(tx.amount ?? 0);
    const userId = tx.user_id;

    // derive new status from payload
    let newStatus = "pending";
    const successRaw = String(payload.success ?? payload.status ?? "").toLowerCase();
    if (successRaw === "true" || successRaw === "success") newStatus = "success";
    else if (successRaw.startsWith("false")) {
      newStatus = payload.auto_refund_status === "processed" ? "refunded" : "failed";
    } else if (payload.status === "failed") newStatus = "failed";

    const apiAmount = payload.amount ? Number(payload.amount) : null;

    // Update transaction row
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

    const sql = `UPDATE transactions SET ${updates.join(", ")} WHERE reference = ?`;
    await db.query(sql, params);

    // If EA processed an auto-refund and transaction wasn't already refunded, credit user wallet
    const isRefunded = newStatus === "refunded";
    if (isRefunded && prevStatus !== "refunded") {
      // Credit user's wallet (idempotent because we check prevStatus)
      const [userRows] = await db.query("SELECT id, balance FROM users WHERE id = ? LIMIT 1", [userId]);
      if (userRows.length) {
        const user = userRows[0];
        const newBalance = Number(user.balance) + txAmount;
        await db.query("UPDATE users SET balance = ? WHERE id = ?", [newBalance, userId]);

        // Insert a refund transaction row (audit)
        const refundRef = `refund_${ref}_${Date.now()}`;
        await db.query(
          `INSERT INTO transactions (user_id, reference, type, amount, api_amount, status, network, plan, phone, via, description, balance_before, balance_after, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            userId,
            refundRef,
            "refund",
            txAmount,
            apiAmount ?? 0,
            "success",
            null,
            null,
            null,
            "auto_refund",
            `Auto refund for reference ${ref}`,
            Number(user.balance),
            newBalance,
          ]
        );
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("webhook error:", err);
    return res.status(500).send("Error");
  }
});

module.exports = router;
