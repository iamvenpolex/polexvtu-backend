const axios = require("axios");
const qs = require("qs");
const db = require("../config/db");

const EASYACCESS_URL = "https://easyaccessapi.com.ng/api/data.php";
const EASYACCESS_TOKEN = process.env.EASYACCESS_TOKEN;

exports.buyData = async (req, res) => {
  const { user_id, network, mobile, dataplan, client_reference } = req.body;

  try {
    const [plan] = await db.promise().query(
      "SELECT * FROM plans WHERE plan_code = ?",
      [dataplan]
    );
    if (!plan.length) return res.status(404).json({ message: "Plan not found" });

    const selling_price = plan[0].selling_price;

    const [user] = await db.promise().query("SELECT * FROM users WHERE id = ?", [
      user_id,
    ]);
    if (user[0].balance < selling_price)
      return res.status(400).json({ message: "Insufficient balance" });

    const data = qs.stringify({
      network,
      mobileno: mobile,
      dataplan,
      client_reference,
      max_amount_payable: selling_price,
    });

    const config = {
      method: "post",
      url: EASYACCESS_URL,
      headers: {
        AuthorizationToken: EASYACCESS_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data,
    };

    const response = await axios(config);

    await db
      .promise()
      .query(
        "INSERT INTO transactions (user_id, type, amount, reference, status, details) VALUES (?, ?, ?, ?, ?, ?)",
        [user_id, "data", selling_price, client_reference, "success", JSON.stringify(response.data)]
      );

    await db
      .promise()
      .query("UPDATE users SET balance = balance - ? WHERE id = ?", [
        selling_price,
        user_id,
      ]);

    res.json({ success: true, message: "Data purchase successful", data: response.data });
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ success: false, message: "Transaction failed", error: err.message });
  }
};
