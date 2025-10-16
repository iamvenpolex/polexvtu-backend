// routes/education.js
const express = require("express");
const axios = require("axios");
const db = require("../config/db"); // your mysql2 or mysql2/promise pool
const router = express.Router();

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN || "";

// documented fallback base prices (from EasyAccess docs)
const documentedPrices = {
  waec: 3300,
  neco: 1150,
  nabteb: 830,
  nbais: 900,
};

// helper: attempt to fetch price from vendor endpoints
async function fetchLivePrice(provider) {
  // provider -> endpoints we will try
  const endpoints = [
    `https://easyaccessapi.com.ng/api/${provider}.php`,        // v1 GET (example in docs)
    `https://easyaccessapi.com.ng/api/${provider}_v2.php`,    // v2 (example uses POST for buys)
  ];

  // header name from their docs: "AuthorizationToken: <token>"
  const headers = { AuthorizationToken: EASY_ACCESS_TOKEN, "cache-control": "no-cache" };

  for (const url of endpoints) {
    try {
      // If endpoint looks like v2 (contains _v2) try POST with minimal valid params
      if (url.includes("_v2")) {
        // v2 normally expects no_of_pins for buying. We won't buy, but try a safe POST with no_of_pins = 1
        // This may return either an error (insufficient balance / invalid token / buy result) or JSON.
        const form = new URLSearchParams();
        form.append("no_of_pins", "1");

        const resp = await axios.post(url, form.toString(), {
          headers: {
            ...headers,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: 5000,
        });

        // Try parse price information if present
        const data = resp.data;
        const detected = parsePriceFromResponse(data);
        if (detected !== null) return detected;

        // If response is JSON and contains amount/price field, return it
        if (data && typeof data === "object") {
          // some v2 success responses include "amount": <number>
          if (typeof data.amount === "number") return data.amount / (Number(form.get("no_of_pins")) || 1);
          if (typeof data.price === "number") return data.price;
        }
      } else {
        // v1 GET attempt
        const resp = await axios.get(url, { headers, timeout: 5000 });

        const data = resp.data;
        const detected = parsePriceFromResponse(data);
        if (detected !== null) return detected;

        // if data is object and contains price fields
        if (data && typeof data === "object") {
          // docs examples sometimes show { "WAEC":[ { price: 3300, ... } ] }
          const keys = Object.keys(data);
          if (keys.length > 0) {
            const first = data[keys[0]];
            if (Array.isArray(first) && first[0] && typeof first[0].price === "number") {
              return first[0].price;
            }
          }

          // direct price field
          if (typeof data.price === "number") return data.price;
        }
      }
    } catch (err) {
      // ignore and try next endpoint; but don't swallow non-network critical errors
      // console.debug('price fetch error for', url, err?.message || err);
    }
  }

  // if all attempts failed, return null so caller can fallback to documented price
  return null;
}

// best-effort parser for different response shapes
function parsePriceFromResponse(data) {
  if (!data) return null;

  // If response is a string and contains a JSON-like object, try JSON parse
  if (typeof data === "string") {
    // quick attempt: if it contains '"price":' try to parse
    if (data.includes('"price"') || data.includes("'price'")) {
      try {
        const parsed = JSON.parse(data);
        // same logic as object below
        if (parsed && typeof parsed === "object") {
          const keys = Object.keys(parsed);
          if (keys.length > 0) {
            const first = parsed[keys[0]];
            if (Array.isArray(first) && first[0] && typeof first[0].price === "number") {
              return first[0].price;
            }
          }
        }
      } catch (e) {
        // not valid JSON
      }
    }
    return null;
  }

  // if object, try common fields
  if (typeof data === "object") {
    // { amount: 3300 } or { price: 3300 }
    if (typeof data.price === "number") return data.price;
    if (typeof data.amount === "number") return data.amount;

    // nested provider object like { "WAEC": [ { price: 3300 } ] }
    const keys = Object.keys(data);
    if (keys.length > 0) {
      const first = data[keys[0]];
      if (Array.isArray(first) && first[0] && typeof first[0].price === "number") {
        return first[0].price;
      }
    }
  }

  return null;
}

/**
 * GET /api/education/prices
 * - For each provider: try to fetch live base_price from EasyAccess
 * - If live fetch fails, fallback to documented price
 * - Merge with any admin-saved profit in education_prices table
 */
router.get("/prices", async (req, res) => {
  try {
    // load current stored admin profits (if any)
    const [stored] = await db.query("SELECT provider, base_price, profit, final_price FROM education_prices");

    // providers to return
    const providers = ["waec", "neco", "nabteb", "nbais"];

    // fetch live prices in parallel
    const livePromises = providers.map((p) => fetchLivePrice(p));
    const liveResults = await Promise.all(livePromises);

    const result = providers.map((provider, idx) => {
      const live = liveResults[idx];
      const fallback = documentedPrices[provider] || null;
      const base_price = live !== null ? Number(live) : Number(fallback);

      // find admin stored record
      const storedRow = stored.find((r) => r.provider === provider);

      // If storedRow exists and has a base_price different (old), keep admin profit but always prefer live base_price
      const profit = storedRow ? Number(storedRow.profit || 0) : 0;
      const final_price = Number(base_price) + Number(profit);

      return {
        provider,
        base_price,
        profit,
        final_price,
      };
    });

    // Optionally: update DB base_price automatically so your table reflects latest base_price
    // We'll upsert base_price but only update base_price+final_price if table exists.
    // This keeps admin profit intact.
    await Promise.all(
      result.map(async (r) => {
        // if row exists, update base_price and final_price but preserve profit
        const [rows] = await db.query("SELECT id, profit FROM education_prices WHERE provider = ?", [r.provider]);
        if (rows.length === 0) {
          // insert initial row
          await db.query(
            "INSERT INTO education_prices (provider, base_price, profit, final_price) VALUES (?, ?, ?, ?)",
            [r.provider, r.base_price, r.profit || 0, r.final_price]
          );
        } else {
          const currentProfit = Number(rows[0].profit || 0);
          const newFinal = Number(r.base_price) + currentProfit;
          await db.query(
            "UPDATE education_prices SET base_price = ?, final_price = ?, updated_at = NOW() WHERE provider = ?",
            [r.base_price, newFinal, r.provider]
          );
        }
      })
    );

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("GET /api/education/prices error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * PUT /api/education/prices/:provider
 * - Admin sets profit (fixed amount)
 * Body: { profit: number }
 * This preserves the base_price (live-fetched) and updates final_price = base_price + profit
 */
router.put("/prices/:provider", async (req, res) => {
  try {
    const { provider } = req.params;
    const { profit } = req.body;
    if (!["waec", "neco", "nabteb", "nbais"].includes(provider)) {
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }

    const numericProfit = Number(profit || 0);
    if (isNaN(numericProfit)) return res.status(400).json({ success: false, message: "Profit must be a number" });

    // get current base_price from DB (if exists) else use documented fallback
    const [rows] = await db.query("SELECT base_price FROM education_prices WHERE provider = ?", [provider]);
    const base_price = rows.length > 0 ? Number(rows[0].base_price) : Number(documentedPrices[provider] || 0);

    const final_price = base_price + numericProfit;

    // upsert row
    if (rows.length === 0) {
      await db.query(
        "INSERT INTO education_prices (provider, base_price, profit, final_price) VALUES (?, ?, ?, ?)",
        [provider, base_price, numericProfit, final_price]
      );
    } else {
      await db.query(
        "UPDATE education_prices SET profit = ?, final_price = ?, updated_at = NOW() WHERE provider = ?",
        [numericProfit, final_price, provider]
      );
    }

    return res.json({ success: true, provider, base_price, profit: numericProfit, final_price });
  } catch (err) {
    console.error("PUT /api/education/prices/:provider error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
