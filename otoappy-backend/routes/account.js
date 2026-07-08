const express = require("express");
const { encryptApiKeyAtRest, decryptApiKeyFromAtRestRow } = require("../utils/crypto");


function validateLooseApiKeyFormat(apiKey) {
  const s = String(apiKey || "").trim();
  // Loosely validate: non-empty and not absurdly long.
  if (s.length < 20) return { ok: false, error: "apiKey is too short" };
  if (s.length > 2000) return { ok: false, error: "apiKey is too long" };
  return { ok: true, value: s };
}

function getUserEncryptedKeyRow({ db, userId }) {
  return db
    .prepare(
      "SELECT userId, apiKeyEncrypted, nonce, tag, encryptionVersion, createdAt, updatedAt FROM user_keys WHERE userId = ?"
    )
    .get(userId);
}

function upsertUserEncryptedKey({ db, userId, apiKeyEncrypted, nonce, tag, encryptionVersion }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_keys (userId, apiKeyEncrypted, nonce, tag, encryptionVersion, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId) DO UPDATE SET
       apiKeyEncrypted=excluded.apiKeyEncrypted,
       nonce=excluded.nonce,
       tag=excluded.tag,
       encryptionVersion=excluded.encryptionVersion,
       updatedAt=excluded.updatedAt`
  ).run(userId, apiKeyEncrypted, nonce, tag, encryptionVersion, now, now);
}

function deleteUserEncryptedKey({ db, userId }) {
  db.prepare("DELETE FROM user_keys WHERE userId = ?").run(userId);
}

module.exports = function buildAccountRoutes({ db, requireAuth, ENCRYPTION_KEY }) {
  const router = express.Router();

  router.post("/api-key", requireAuth, async (req, res) => {
    try {
      const { apiKey } = req.body || {};
      const validated = validateLooseApiKeyFormat(apiKey);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const encrypted = encryptApiKeyAtRest({ apiKey: validated.value, ENCRYPTION_KEY });

      upsertUserEncryptedKey({
        db,
        userId: req.userId,
        apiKeyEncrypted: encrypted.apiKeyEncrypted,
        nonce: encrypted.nonce,
        tag: encrypted.tag,
        encryptionVersion: encrypted.encryptionVersion
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error("[POST /account/api-key] Error:", err);
      return res.status(500).json({ error: "Failed to save API key" });
    }
  });

  router.get("/api-key/status", requireAuth, async (req, res) => {
    try {
      const row = getUserEncryptedKeyRow({ db, userId: req.userId });
      return res.json({ hasKey: !!row });
    } catch (err) {
      console.error("[GET /account/api-key/status] Error:", err);
      return res.status(500).json({ error: "Failed to get status" });
    }
  });

  router.delete("/api-key", requireAuth, async (req, res) => {
    try {
      deleteUserEncryptedKey({ db, userId: req.userId });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[DELETE /account/api-key] Error:", err);
      return res.status(500).json({ error: "Failed to remove API key" });
    }
  });

  return {
    router,
    // Export decrypt helpers for coverLetter/parseResume
    decryptApiKeyFromAtRestRow: ({ row }) =>
      decryptApiKeyFromAtRestRow({ row, ENCRYPTION_KEY }),
    getUserEncryptedKeyRow: ({ userId }) =>
      getUserEncryptedKeyRow({ db, userId })
  };
};


