// config/db.js
const mysql = require("mysql2/promise");
require("dotenv").config();

// MySQL connection
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

db.getConnection()
  .then(() => console.log("✅ MySQL Connected"))
  .catch((err) => console.error("❌ DB Connection Failed:", err));

module.exports = db;

// Paystack secret key (export separately)
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
module.exports.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET_KEY;
