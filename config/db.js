// config/db.js
const postgres = require("postgres");
require("dotenv").config();

const db = postgres(process.env.DATABASE_URL, {
  ssl: "require",
  prepare: false,      // ← fixes "prepared statement does not exist" on Supabase/Render
  max: 10,             // max connections in pool
  idle_timeout: 30,    // close idle connections after 30s
  connect_timeout: 10, // fail fast if can't connect
});

module.exports = db;