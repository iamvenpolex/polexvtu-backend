// backend/services/vtuService.js
const axios = require("axios");
const qs = require("qs");

const EASYACCESS_TOKEN = process.env.EASYACCESS_TOKEN;

// General function to call EasyAccess API
async function callEasyAccess(endpoint, payload) {
  const data = qs.stringify(payload);

  const config = {
    method: "post",
    url: `https://easyaccessapi.com.ng/api/${endpoint}.php`,
    headers: {
      AuthorizationToken: EASYACCESS_TOKEN,
      "cache-control": "no-cache",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    data,
  };

  const response = await axios(config);
  return response.data;
}

// Service-specific logic
async function buyData({ network, mobileno, dataplan, client_reference, max_amount_payable }) {
  return await callEasyAccess("data", {
    network,
    mobileno,
    dataplan,
    client_reference,
    max_amount_payable,
  });
}

async function buyAirtime({ network, mobileno, amount, client_reference }) {
  return await callEasyAccess("airtime", {
    network,
    mobileno,
    amount,
    client_reference,
  });
}

async function buyCable({ provider, smartcardno, variation_code, client_reference }) {
  return await callEasyAccess("cabletv", {
    provider,
    smartcardno,
    variation_code,
    client_reference,
  });
}

async function buyElectricity({ disco, meter_number, amount, client_reference }) {
  return await callEasyAccess("electricity", {
    disco,
    meter_number,
    amount,
    client_reference,
  });
}

module.exports = {
  buyData,
  buyAirtime,
  buyCable,
  buyElectricity,
};
