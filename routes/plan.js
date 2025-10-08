const express = require("express");
const db = require("../config/db");
const router = express.Router();

// GET /api/plan
router.get("/plan", async (req, res) => {
  const { provider_id } = req.query;

  try {
    let query = "SELECT * FROM plans";
    const params = [];

    if (provider_id) {
      query += " WHERE provider_id = ?";
      params.push(provider_id);
    }

    const [plans] = await db.promise().query(query, params);
    res.json(plans);
  } catch (error) {
    console.error("Error fetching plans:", error);
    res.status(500).json({ message: "Error fetching plans" });
  }
});

module.exports = router;
