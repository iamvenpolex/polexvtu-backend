import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

// Health check route
app.get("/ping", (req, res) => {
  res.status(200).json({ message: "pong" });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
