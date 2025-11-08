import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../config/db.js"; // Postgres.js client
import dotenv from "dotenv";

dotenv.config();

export const register = async (req, res) => {
  const { first_name, last_name, email, phone, password, confirmPassword, gender, referral } = req.body;

  if (!first_name || !last_name || !email || !phone || !password || !confirmPassword) {
    return res.status(400).json({ message: "All fields are required" });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ message: "Passwords do not match" });
  }

  try {
    // Check existing user
    const existingUser = await db`SELECT * FROM users WHERE email = ${email}`;
    if (existingUser.length > 0) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    const newUser = await db`
      INSERT INTO users (first_name, last_name, email, phone, password, gender, referral, role)
      VALUES (${first_name}, ${last_name}, ${email}, ${phone}, ${hashedPassword}, ${gender}, ${referral}, 'user')
      RETURNING id
    `;

    const token = jwt.sign({ id: newUser[0].id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({ message: "User registered successfully", token });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ message: "Email and password are required" });

  try {
    const user = await db`SELECT * FROM users WHERE email = ${email}`;
    if (!user || user.length === 0) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user[0].password);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign({ id: user[0].id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.status(200).json({ message: "Login successful", token });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
