"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/db");
const adminAuth = require("../middleware/adminAuth");

// ─────────────────────────────────────────────────────────────
// GET /api/notifications
// Public — fetches all notifications for the dashboard popup
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const notifications = await db`
      SELECT id, title, message, created_at
      FROM notifications
      ORDER BY created_at DESC
    `;

    res.json({ success: true, notifications });
  } catch (err) {
    console.error("Fetch notifications error:", err.message);
    res.status(500).json({ success: false, message: "Failed to fetch notifications" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/notifications
// Admin only — create a new notification
// Body: { title, message }
// ─────────────────────────────────────────────────────────────
router.post("/", adminAuth, async (req, res) => {
  const { title, message } = req.body;

  if (!title?.trim() || !message?.trim()) {
    return res.status(400).json({ success: false, message: "Title and message are required" });
  }

  try {
    const result = await db`
      INSERT INTO notifications (title, message)
      VALUES (${title.trim()}, ${message.trim()})
      RETURNING id, title, message, created_at
    `;

    res.status(201).json({ success: true, notification: result[0] });
  } catch (err) {
    console.error("Create notification error:", err.message);
    res.status(500).json({ success: false, message: "Failed to create notification" });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/notifications/:id
// Admin only — delete a notification
// ─────────────────────────────────────────────────────────────
router.delete("/:id", adminAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db`
      DELETE FROM notifications WHERE id = ${id} RETURNING id
    `;

    if (!result.length) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.json({ success: true, message: "Notification deleted" });
  } catch (err) {
    console.error("Delete notification error:", err.message);
    res.status(500).json({ success: false, message: "Failed to delete notification" });
  }
});

module.exports = router;