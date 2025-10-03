// config/db.js
const mysql = require("mysql2/promise");
require("dotenv").config();

// MySQL connection pool (works locally + on Railway)
const db = mysql.createPool({
  host: process.env.MYSQLHOST || process.env.DB_HOST || "localhost",
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER || "root",
  password: process.env.MYSQLPASSWORD || process.env.DB_PASS || "",
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || "test",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test connection
db.getConnection()
  .then(() => console.log("✅ MySQL Connected"))
  .catch((err) => console.error("❌ DB Connection Failed:", err));

module.exports = db;

// Export Paystack secret key separately
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
module.exports.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET_KEY;
