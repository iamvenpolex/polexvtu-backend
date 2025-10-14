const express = require("express");
const axios = require("axios");
const db = require("../config/db");
const router = express.Router();

const API_TOKEN = process.env.EASY_ACCESS_TOKEN;
const VERIFY_URL = "https://easyaccessapi.com.ng/api/verifytv.php";
const PAY_URL = "https://easyaccessapi.com.ng/api/paytv.php";

/**
 * POST /buycabletv
 * Body: { user_id, company_code, package_code, iuc_no, client_reference }
 */
router.post("/", async (req, res) => {
  const { user_id, company_code, package_code, iuc_no, client_reference } = req.body;

  if (!user_id || !company_code || !package_code || !iuc_no || !client_reference) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    // 1️⃣ Verify IUC/Smart Card
    const verifyRes = await axios.post(
      VERIFY_URL,
      { company: company_code, iucno: iuc_no },
      { headers: { AuthorizationToken: API_TOKEN } }
    );

    if (!verifyRes.data.success) {
      return res.status(400).json({ success: false, message: verifyRes.data.message });
    }

    const customerName = verifyRes.data.message.content.Customer_Name;

    // 2️⃣ Fetch user & plan
    const [users] = await db.query("SELECT id, balance FROM users WHERE id = ?", [user_id]);
    if (!users.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    const [plans] = await db.query(
      "SELECT package_name, custom_price FROM custom_cabletv_prices WHERE company_code=? AND package_code=? AND status='active'",
      [company_code, package_code]
    );
    if (!plans.length) return res.status(400).json({ success: false, message: "Plan not available" });
    const plan = plans[0];

    // 3️⃣ Check user balance
    const price = parseFloat(plan.custom_price);
    if (user.balance < price) return res.status(400).json({ success: false, message: "Insufficient balance" });

    // 4️⃣ Deduct balance and create pending transaction
    const balance_before = parseFloat(user.balance);
    const balance_after = balance_before - price;
    await db.query("UPDATE users SET balance=? WHERE id=?", [balance_after, user.id]);

    await db.query(
      `INSERT INTO transactions
        (user_id, reference, type, amount, status, plan, phone, via, description, balance_before, balance_after)
       VALUES (?, ?, 'cabletv', ?, 'pending', ?, ?, 'wallet', ?, ?, ?)`,
      [user.id, client_reference, price, plan.package_name, iuc_no, `Cable TV purchase of ${plan.package_name}`, balance_before, balance_after]
    );

    // 5️⃣ Call EasyAccess Pay API
    const payRes = await axios.post(
      PAY_URL,
      { company: company_code, iucno: iuc_no, package: package_code, max_amount_payable: price },
      { headers: { AuthorizationToken: API_TOKEN } }
    );

    if (payRes.data.success) {
      await db.query("UPDATE transactions SET status='success' WHERE reference=?", [client_reference]);
      return res.json({ success: true, message: "Purchase successful", customerName, amount: price });
    } else {
      // Refund wallet
      await db.query("UPDATE users SET balance=? WHERE id=?", [balance_before, user.id]);
      await db.query("UPDATE transactions SET status='failed' WHERE reference=?", [client_reference]);
      return res.status(400).json({ success: false, message: payRes.data.message });
    }
  } catch (error) {
    console.error("Buy Cable TV error:", error.message);
    return res.status(500).json({ success: false, message: "Error purchasing Cable TV", error: error.message });
  }
});

module.exports = router;
