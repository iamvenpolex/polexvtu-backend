const express = require("express");
const router = express.Router();
const vtuController = require("../controllers/vtuController");

router.post("/buy-data", vtuController.buyData);

module.exports = router;
