"use strict";

const express = require("express");
const router = express.Router();
const db = require("../config/db");

// =====================================================
// GET ALL ACTIVE NOTIFICATIONS
// GET /api/notifications
// Used by users
// =====================================================

router.get("/", async (req, res) => {
  try {
    const notifications = await db`
      SELECT
        id,
        title,
        message,
        type,
        created_at
      FROM notifications
      WHERE is_active = TRUE
      ORDER BY created_at DESC
    `;

    return res.status(200).json({
      success: true,
      notifications,
    });
  } catch (error) {
    console.error(
      "❌ Failed to fetch notifications:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
    });
  }
});

// =====================================================
// CREATE NOTIFICATION
// POST /api/notifications
// Used by ADMIN
// =====================================================

router.post("/", async (req, res) => {
  try {
    const { title, message, type } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "Title and message are required",
      });
    }

    const cleanTitle = String(title).trim();
    const cleanMessage = String(message).trim();
    const cleanType = String(type || "info").trim().toLowerCase();

    if (!cleanTitle || !cleanMessage) {
      return res.status(400).json({
        success: false,
        message: "Title and message cannot be empty",
      });
    }

    const allowedTypes = [
      "info",
      "success",
      "warning",
      "error",
    ];

    if (!allowedTypes.includes(cleanType)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid notification type. Use info, success, warning, or error.",
      });
    }

    const rows = await db`
      INSERT INTO notifications (
        title,
        message,
        type,
        is_active
      )
      VALUES (
        ${cleanTitle},
        ${cleanMessage},
        ${cleanType},
        TRUE
      )
      RETURNING
        id,
        title,
        message,
        type,
        is_active,
        created_at
    `;

    return res.status(201).json({
      success: true,
      message: "Notification created successfully",
      notification: rows[0],
    });
  } catch (error) {
    console.error(
      "❌ Failed to create notification:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to create notification",
    });
  }
});

// =====================================================
// DELETE NOTIFICATION
// DELETE /api/notifications/:id
// Used by ADMIN
// =====================================================

router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification ID",
      });
    }

    const rows = await db`
      DELETE FROM notifications
      WHERE id = ${id}
      RETURNING id
    `;

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notification deleted successfully",
    });
  } catch (error) {
    console.error(
      "❌ Failed to delete notification:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to delete notification",
    });
  }
});

// =====================================================
// DEACTIVATE NOTIFICATION
// PATCH /api/notifications/:id/deactivate
// Optional admin feature
// =====================================================

router.patch("/:id/deactivate", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification ID",
      });
    }

    const rows = await db`
      UPDATE notifications
      SET
        is_active = FALSE,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING
        id,
        title,
        message,
        type,
        is_active,
        updated_at
    `;

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notification deactivated successfully",
      notification: rows[0],
    });
  } catch (error) {
    console.error(
      "❌ Failed to deactivate notification:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to deactivate notification",
    });
  }
});

module.exports = router;

