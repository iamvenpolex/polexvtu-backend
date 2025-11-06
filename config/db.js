// config/db.js
const postgres = require("postgres");
require("dotenv").config();

// ✅ Create PostgreSQL client using Supabase connection string
const db = postgres(process.env.DATABASE_URL, {
  ssl: "require", // ✅ Supabase requires SSL
});

// ✅ Test database connection
(async () => {
  try {
    await db`SELECT 1`;
    console.log("✅ PostgreSQL Connected to Supabase");
  } catch (err) {
    console.error("❌ PostgreSQL Connection Failed:", err.message);
  }
})();

module.exports = db;
