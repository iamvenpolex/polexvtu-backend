const axios = require("axios");

class SMSClone {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.baseURL = "https://smsclone.com/api/sms";
  }

  buildQuery(params) {
    return new URLSearchParams(params).toString();
  }

  async sendNormal({ sender, recipients, message }) {
    const url = `${this.baseURL}/sendsms?${this.buildQuery({
      username: this.username,
      password: this.password,
      sender,
      recipient: recipients.join(","),
      message,
    })}`;
    return this.sendRequest(url);
  }

  async sendDND({ sender, recipients, message }) {
    const url = `${this.baseURL}/dnd-route?${this.buildQuery({
      username: this.username,
      password: this.password,
      sender,
      recipient: recipients.join(","),
      message,
    })}`;
    return this.sendRequest(url);
  }

  async sendDNDFallback({ sender, recipients, message }) {
    const url = `${this.baseURL}/dnd-fallback?${this.buildQuery({
      username: this.username,
      password: this.password,
      sender,
      recipient: recipients.join(","),
      message,
    })}`;
    return this.sendRequest(url);
  }

  async checkBalance() {
    const url = `${this.baseURL}/balance?${this.buildQuery({
      username: this.username,
      password: this.password,
      balance: true,
    })}`;
    return this.sendRequest(url);
  }

  async sendRequest(url) {
    try {
      const response = await axios.get(url);
      return this.parseResponse(response.data);
    } catch (error) {
      throw new Error(error.response?.data || error.message);
    }
  }

  parseResponse(data) {
    if (typeof data === "string" && data.includes("BALANCE")) {
      return { balance: data };
    }
    const [statusCode, rest] = data.split("-");
    const batchInfo = rest?.split(",")?.map((item) => {
      const [msgCode, recipient, msgId, msgStatus, description] = item.split("|");
      return { msgCode, recipient, msgId, msgStatus, description };
    });
    return { statusCode, batchInfo };
  }
}

module.exports = SMSClone;
