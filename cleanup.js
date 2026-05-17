"use strict";

const db = require("./config/db");

// ─────────────────────────────────────────────────────────────
// Auto-delete transactions older than 30 days
// Runs once on startup, then every 24 hours.
// ─────────────────────────────────────────────────────────────

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function deleteOldTransactions() {
  try {
    const result = await db`
      DELETE FROM transactions
      WHERE created_at < NOW() - INTERVAL '30 days'
      RETURNING id
    `;

    const count = result.length;

    if (count > 0) {
      console.log(`[cleanup] Deleted ${count} transaction(s) older than 30 days.`);
    } else {
      console.log(`[cleanup] No old transactions to delete.`);
    }
  } catch (err) {
    console.error("[cleanup] Failed to delete old transactions:", err.message);
  }
}

function startCleanupJob() {
  console.log("[cleanup] Transaction cleanup job started (runs every 24h).");

  // Run immediately on startup
  deleteOldTransactions();

  // Then repeat every 24 hours
  setInterval(deleteOldTransactions, INTERVAL_MS);
}

module.exports = { startCleanupJob };