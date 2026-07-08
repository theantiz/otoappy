const path = require("path");
const Database = require("better-sqlite3");

function createDb() {
  const dbFile = path.join(__dirname, "..", "job-autofill.db");
  const db = new Database(dbFile);
  return db;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      userId INTEGER PRIMARY KEY,
      firstName TEXT,
      lastName TEXT,
      email TEXT,
      phone TEXT,
      addressJson TEXT,
      experienceJson TEXT,
      educationJson TEXT,
      skillsJson TEXT,
      updatedAt TEXT,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Encrypted API keys per user (never return to frontend)
    CREATE TABLE IF NOT EXISTS user_keys (
      userId INTEGER PRIMARY KEY,
      apiKeyEncrypted TEXT NOT NULL,
      nonce TEXT NOT NULL,
      tag TEXT NOT NULL,
      encryptionVersion INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

module.exports = function setupDb() {
  const db = createDb();
  initDb(db);
  return db;
};

