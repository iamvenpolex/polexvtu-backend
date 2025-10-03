const mysql = require("mysql2/promise");
require("dotenv").config();

const db = mysql.createPool({
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASS,
  database: process.env.MYSQLDATABASE || process.env.DB_NAME,
});

db.getConnection()
  .then(() => console.log("✅ MySQL Connected"))
  .catch((err) => console.error("❌ DB Connection Failed:", err));

module.exports = db;

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
module.exports.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET_KEY;
