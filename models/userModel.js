import db from "../config/db.js"; // your Postgres.js client

export const findUserByEmail = async (email) => {
  const rows = await db`
    SELECT * FROM users WHERE email = ${email}
  `;
  return rows[0]; // returns undefined if not found
};

export const createUser = async (user) => {
  const { first_name, last_name, email, phone, password, gender, referral } = user;
  
  const newUser = await db`
    INSERT INTO users (first_name, last_name, email, phone, password, gender, referral)
    VALUES (${first_name}, ${last_name}, ${email}, ${phone}, ${password}, ${gender}, ${referral})
    RETURNING id
  `;
  
  return newUser[0]; // returns the inserted row
};
