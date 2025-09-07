import { db } from "../config/db.js";

export const findUserByEmail = async (email) => {
  const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
  return rows[0];
};

export const createUser = async (user) => {
  const { first_name, last_name, email, phone, password, gender, referral } = user;
  const [result] = await db.query(
    `INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, 'user')`,
    [`${first_name} ${last_name}`, email, phone, password]
  );
  return result;
};
