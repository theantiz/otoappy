const crypto = require("crypto");

function getEncryptionKeyBytes({ ENCRYPTION_KEY }) {
  const enc = ENCRYPTION_KEY;
  if (!enc) {
    throw new Error("Server misconfiguration: ENCRYPTION_KEY is not set");
  }
  return crypto.createHash("sha256").update(String(enc)).digest();
}

function encryptApiKeyAtRest({ apiKey, ENCRYPTION_KEY }) {
  const keyBytes = getEncryptionKeyBytes({ ENCRYPTION_KEY });

  const iv = crypto.randomBytes(12); // recommended size for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);

  const plaintext = String(apiKey);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    apiKeyEncrypted: ciphertext.toString("base64"),
    nonce: iv.toString("base64"),
    tag: tag.toString("base64"),
    encryptionVersion: 1
  };
}

function decryptApiKeyFromAtRestRow({ row, ENCRYPTION_KEY }) {
  if (!row?.apiKeyEncrypted || !row?.nonce || !row?.tag) {
    return null;
  }

  const keyBytes = getEncryptionKeyBytes({ ENCRYPTION_KEY });
  const iv = Buffer.from(String(row.nonce), "base64");
  const tag = Buffer.from(String(row.tag), "base64");
  const ciphertext = Buffer.from(String(row.apiKeyEncrypted), "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

module.exports = {
  encryptApiKeyAtRest,
  decryptApiKeyFromAtRestRow
};

