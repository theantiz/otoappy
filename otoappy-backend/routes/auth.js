const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function createRequireAuth({ JWT_SECRET }) {
  return function requireAuth(req, res, next) {
    const authHeader = req.headers?.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const match = String(authHeader).match(/^Bearer\\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = match[1];

    if (!JWT_SECRET) {
      return res.status(500).json({ error: "Server misconfiguration" });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.userId = payload?.userId;

      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      return next();
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
  };
}

module.exports = function buildAuthRoutes({ db, JWT_SECRET }) {
  router.post("/signup", async (req, res) => {
    try {
      const { email, password } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({ error: "email and password are required" });
      }

      const normalizedEmail = normalizeEmail(email);

      if (password.length < 8) {
        return res.status(400).json({ error: "password must be at least 8 characters" });
      }

      if (!JWT_SECRET) {
        return res.status(500).json({ error: "Server misconfiguration" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const createdAt = new Date().toISOString();

      try {
        const stmt = db.prepare(
          "INSERT INTO users (email, passwordHash, createdAt) VALUES (?, ?, ?)"
        );
        const info = stmt.run(normalizedEmail, passwordHash, createdAt);

        const userId = info.lastInsertRowid;
        const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });

        return res.status(201).json({ token, userId });
      } catch (err) {
        // SQLite constraint violation (UNIQUE)
        if (String(err && err.message).toLowerCase().includes("unique")) {
          return res.status(409).json({ error: "email already registered" });
        }
        throw err;
      }
    } catch (err) {
      console.error("[POST /auth/signup] Error:", err);
      return res.status(500).json({ error: "Signup failed" });
    }
  });

  router.post("/login", async (req, res) => {
    try {
      const { email, password } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({ error: "email and password are required" });
      }

      if (!JWT_SECRET) {
        return res.status(500).json({ error: "Server misconfiguration" });
      }

      const normalizedEmail = normalizeEmail(email);

      const user = db
        .prepare("SELECT id, email, passwordHash FROM users WHERE email = ?")
        .get(normalizedEmail);

      if (!user) {
        return res.status(401).json({ error: "invalid credentials" });
      }

      const ok = await bcrypt.compare(String(password), user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: "invalid credentials" });
      }

      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });
      return res.json({ token, userId: user.id });
    } catch (err) {
      console.error("[POST /auth/login] Error:", err);
      return res.status(500).json({ error: "Login failed" });
    }
  });

  return {
    router,
    requireAuth: createRequireAuth({ JWT_SECRET })
  };
};

