const mysql = require("mysql2/promise");
require("dotenv").config();

// MySQL connection pool
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, // ✅ fixed name
  database: process.env.DB_NAME,
});

// Test connection once at startup
db.getConnection()
  .then(() => console.log("✅ MySQL Connected to Railway"))
  .catch((err) => console.error("❌ DB Connection Failed:", err));

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Export both db and Paystack key
module.exports = {
  db,
  PAYSTACK_SECRET_KEY,
};
