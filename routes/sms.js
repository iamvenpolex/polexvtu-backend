const express = require("express");
const router = express.Router();
const SMSClone = require("../utils/smsclone");

// Use environment variables for security
const sms = new SMSClone(process.env.SMS_USERNAME, process.env.SMS_PASSWORD);

// Send SMS Normal
router.post("/normal", async (req, res) => {
  try {
    const { sender, recipients, message } = req.body;
    const response = await sms.sendNormal({ sender, recipients, message });
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send SMS DND
router.post("/dnd", async (req, res) => {
  try {
    const { sender, recipients, message } = req.body;
    const response = await sms.sendDND({ sender, recipients, message });
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send SMS DND Fallback
router.post("/dnd-fallback", async (req, res) => {
  try {
    const { sender, recipients, message } = req.body;
    const response = await sms.sendDNDFallback({ sender, recipients, message });
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Check Balance
router.get("/balance", async (req, res) => {
  try {
    const response = await sms.checkBalance();
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
