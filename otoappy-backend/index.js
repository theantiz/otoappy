// job-autofill-backend/index.js

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");
const Database = require("better-sqlite3");
const crypto = require("crypto");



const app = express();

app.use(express.json());


const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: corsOrigin
  })
);

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Job Autofill Backend" });
});

// =============================
// Auth + SQLite
// =============================

const JWT_SECRET = process.env.JWT_SECRET;

const dbFile = path.join(__dirname, "job-autofill.db");
const db = new Database(dbFile);

function initDb() {
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


initDb();

function requireAuth(req, res, next) {
  const authHeader = req.headers?.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
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
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// =============================
// Per-user API key encryption (AES-256-GCM)
// =============================

function getEncryptionKeyBytes() {
  const enc = process.env.ENCRYPTION_KEY;
  if (!enc) {
    throw new Error("Server misconfiguration: ENCRYPTION_KEY is not set");
  }
  // Derive 32 bytes from arbitrary string
  return crypto.createHash("sha256").update(String(enc)).digest();
}

function encryptApiKeyAtRest(apiKey) {
  const keyBytes = getEncryptionKeyBytes();

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

function decryptApiKeyFromAtRestRow(row) {
  if (!row?.apiKeyEncrypted || !row?.nonce || !row?.tag) {
    return null;
  }

  const keyBytes = getEncryptionKeyBytes();
  const iv = Buffer.from(String(row.nonce), "base64");
  const tag = Buffer.from(String(row.tag), "base64");
  const ciphertext = Buffer.from(String(row.apiKeyEncrypted), "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

function validateLooseApiKeyFormat(apiKey) {
  const s = String(apiKey || "").trim();
  // Loosely validate: non-empty and not absurdly long.
  if (s.length < 20) return { ok: false, error: "apiKey is too short" };
  if (s.length > 2000) return { ok: false, error: "apiKey is too long" };
  return { ok: true, value: s };
}

function getUserEncryptedKeyRow(userId) {
  return db
    .prepare(
      "SELECT userId, apiKeyEncrypted, nonce, tag, encryptionVersion, createdAt, updatedAt FROM user_keys WHERE userId = ?"
    )
    .get(userId);
}

function upsertUserEncryptedKey({ userId, apiKeyEncrypted, nonce, tag, encryptionVersion }) {
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

function deleteUserEncryptedKey(userId) {
  db.prepare("DELETE FROM user_keys WHERE userId = ?").run(userId);
}


app.post("/auth/signup", async (req, res) => {
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

app.post("/auth/login", async (req, res) => {
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


/**
 * Generate a cover letter using OpenAI (if OPENAI_API_KEY exists), otherwise
 * return a simple fallback string for local testing.
 */
async function generateCoverLetter({ profileData, jobContext, apiKey }) {

  const safe = (v) => (v === undefined || v === null ? "" : String(v));

  const fullName = safe(profileData?.fullName);
  const role = safe(jobContext?.role);
  const company = safe(jobContext?.company);

  const address = safe(profileData?.address);
  const location = safe(profileData?.location);
  const portfolio = safe(profileData?.portfolio);
  const github = safe(profileData?.github);
  const linkedin = safe(profileData?.linkedin);

  const whyRole = safe(profileData?.whyRole);
  const aboutMe = safe(profileData?.aboutMe);

  const phone = safe(profileData?.phone);
  const email = safe(profileData?.email);

  // Fallback: no API key
  if (!apiKey) {

    const contactLine = [email, phone].filter(Boolean).join(" | ");
    const links = [
      portfolio ? `Portfolio: ${portfolio}` : "",
      github ? `GitHub: ${github}` : "",
      linkedin ? `LinkedIn: ${linkedin}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const locationLine = [location, address].filter(Boolean).join(", ");

    return [
      `Dear Hiring Manager,`,
      `\nI’m ${fullName || "excited"} applying for the ${role || "role"} position at ${company || "your company"}.`,
      `\nWhy I’m interested: ${whyRole || "I’m motivated by the opportunity and the chance to contribute."}`,
      `\nAbout me: ${aboutMe || "I bring relevant experience and strong communication skills."}`,
      links ? `\n${links}` : "",
      locationLine ? `\nBased in: ${locationLine}` : "",
      `\nThank you for your time and consideration. I’d welcome the opportunity to discuss how I can help ${company || ""}.`,
      `\nSincerely,`,
      fullName || "" ,
      contactLine ? `\n${contactLine}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";


  const profileBlock = [
    `Full name: ${fullName}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Address: ${address}`,
    `Location: ${location}`,
    `Portfolio: ${portfolio}`,
    `GitHub: ${github}`,
    `LinkedIn: ${linkedin}`,
    `Why this role: ${whyRole}`,
    `About me: ${aboutMe}`
  ]
    .filter((l) => l && !l.endsWith(": "))
    .join("\n");

  const contextBlock = [
    `Role: ${role}`,
    `Company: ${company}`
  ]
    .filter((l) => l && !l.endsWith(": "))
    .join("\n");

  const systemMessage = "You write concise, professional cover letters for tech job applications.";

  const userPrompt = [
    `Write a 3–6 paragraph cover letter for the following job context.`,
    `Use a friendly but professional tone.`,
    `- Mention the role and company explicitly.`,
    `- Highlight experience and skills based on About me.`,
    `- Explain motivation based on Why this role.`,
    `- Mention portfolio/GitHub if present.`,
    `- Optionally reference city/address if relevant.`,
    `- End with a polite closing.`,
    ``,
    `=== Job Context ===`,
    contextBlock,
    ``,
    `=== Candidate Profile ===`,
    profileBlock
  ].join("\n");

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,

        "Content-Type": "application/json"
      },
      timeout: 60_000
    }
  );

  // The API returns { choices: [ { message: { content } } ] }
  return response.data?.choices?.[0]?.message?.content || "";
}

app.get('/profile', requireAuth, (req, res) => {

  const row = db
    .prepare(
      'SELECT firstName, lastName, email, phone, addressJson, experienceJson, educationJson, skillsJson, updatedAt FROM profiles WHERE userId = ?'
    )
    .get(req.userId);

  if (!row) {
    return res.json(null);
  }

  const address = (() => {
    try {
      return JSON.parse(row.addressJson || '{}');
    } catch {
      return {};
    }
  })();

  const experience = (() => {
    try {
      return JSON.parse(row.experienceJson || '[]');
    } catch {
      return [];
    }
  })();

  const education = (() => {
    try {
      return JSON.parse(row.educationJson || '[]');
    } catch {
      return [];
    }
  })();

  const skills = (() => {
    try {
      return JSON.parse(row.skillsJson || '[]');
    } catch {
      return [];
    }
  })();

  return res.json({
    firstName: row.firstName || '',
    lastName: row.lastName || '',
    email: row.email || '',
    phone: row.phone || '',
    address,
    experience,
    education,
    skills,
    updatedAt: row.updatedAt || ''
  });
});

app.post('/account/api-key', requireAuth, async (req, res) => {
  try {
    const { apiKey } = req.body || {};
    const validated = validateLooseApiKeyFormat(apiKey);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    const encrypted = encryptApiKeyAtRest(validated.value);

    upsertUserEncryptedKey({
      userId: req.userId,
      apiKeyEncrypted: encrypted.apiKeyEncrypted,
      nonce: encrypted.nonce,
      tag: encrypted.tag,
      encryptionVersion: encrypted.encryptionVersion
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /account/api-key] Error:', err);
    return res.status(500).json({ error: 'Failed to save API key' });
  }
});

app.get('/account/api-key/status', requireAuth, async (req, res) => {
  try {
    const row = getUserEncryptedKeyRow(req.userId);
    return res.json({ hasKey: !!row });
  } catch (err) {
    console.error('[GET /account/api-key/status] Error:', err);
    return res.status(500).json({ error: 'Failed to get status' });
  }
});

app.delete('/account/api-key', requireAuth, async (req, res) => {
  try {
    deleteUserEncryptedKey(req.userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /account/api-key] Error:', err);
    return res.status(500).json({ error: 'Failed to remove API key' });
  }
});

app.post("/generate-cover", requireAuth, async (req, res) => {

  try {
    const { profileData, jobContext } = req.body || {};

    if (!profileData) {
      return res.status(400).json({ error: "profileData is required" });
    }

    const userKeyRow = getUserEncryptedKeyRow(req.userId);
    if (!userKeyRow) {
      return res.status(400).json({ error: "No API key configured" });
    }

    const decryptedApiKey = decryptApiKeyFromAtRestRow(userKeyRow);
    if (!decryptedApiKey) {
      return res.status(500).json({ error: "Failed to decrypt API key" });
    }

    const coverLetter = await generateCoverLetter({ profileData, jobContext, apiKey: decryptedApiKey });

    return res.json({ coverLetter });
  } catch (err) {
    console.error("[POST /generate-cover] Error:", err?.response?.data || err);
    return res.status(500).json({ error: "Failed to generate cover letter" });
  }
});


// Resume parsing endpoint (no changes to other routes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

function stripMarkdownFences(s) {
  return String(s || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
}

function safeParseJson(jsonText) {
  try {
    return JSON.parse(stripMarkdownFences(jsonText));
  } catch (e) {
    // Try extracting the first {...} block as a fallback.
    const str = String(jsonText || "");
    const match = str.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(stripMarkdownFences(match[0]));
    }
    throw e;
  }
}

function cleanLatexToPlainText(input) {
  let s = String(input || "");

  // Remove LaTeX comments (keep content before % on each line)
  s = s.replace(/%.*$/gm, "");

  // Remove common preamble blocks
  s = s.replace(/[\s\S]*?\\begin\{document\}/i, "");

  // Remove environments by keeping inner content
  // e.g. \begin{abstract} ... \end{abstract}
  s = s.replace(/\\begin\{[^}]+\}([\s\S]*?)\\end\{[^}]+\}/gi, "$1");

  // Remove simple \command{...} keeping inner content
  // Run multiple times to handle nesting best-effort.
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\[a-zA-Z]+\s*\{([^}]*)\}/g, "$1");
  }

  // Remove standalone commands like \today, \url{...} variants after above pass might still leave them
  s = s.replace(/\\[a-zA-Z]+\b/g, "");

  // Collapse whitespace
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");

  return s.trim();
}

async function parseResumeTextFromFile({ buffer, mimetype, originalname }) {
  const lower = String(originalname || "").toLowerCase();

  if (mimetype === "application/pdf" || lower.endsWith(".pdf")) {
    const data = await pdfParse(buffer);
    return data?.text || "";
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result?.value || "";
  }

  const isTex =
    mimetype === "application/x-tex" ||
    mimetype === "text/x-tex" ||
    lower.endsWith(".tex");

  if (isTex) {
    const raw = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
    return cleanLatexToPlainText(raw);
  }

  throw new Error("Unsupported file type");
}

async function extractProfileFieldsFromResumeText(rawText, apiKey) {

  const schema = {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    address: { street: "", city: "", state: "", zip: "", country: "" },
    experience: [
      {
        title: "",
        company: "",
        startDate: "",
        endDate: "",
        description: ""
      }
    ],
    education: [
      {
        school: "",
        degree: "",
        field: "",
        graduationYear: ""
      }
    ],
    skills: []
  };

  // Reuse the same provider/setup as cover letter: OpenAI chat completions.
  // NOTE: We only ask for JSON-only content.
  if (!apiKey) {
    throw new Error("No API key configured");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const systemMessage = [
    "You are a helpful assistant that extracts structured candidate data from resumes.",
    "Return ONLY valid JSON. No markdown fences, no preamble, no extra keys."
  ].join("\n");

  const userPrompt = [
    "Extract the following fields from the resume text.",
    "If a field is missing, use an empty string (or empty array/object for nested fields).",
    "Return JSON ONLY matching the exact schema.",
    "Schema:",
    JSON.stringify(schema),
    "",
    "=== Resume Text ===",
    rawText
  ].join("\n");

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userPrompt }
      ],
      temperature: 0
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,

        "Content-Type": "application/json"
      },
      timeout: 120_000
    }
  );

  const content = response.data?.choices?.[0]?.message?.content || "";
  return safeParseJson(content);
}

app.post(
  "/parse-resume",
  requireAuth,
  upload.single("resume"),
  async (req, res) => {
    try {
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "resume file is required" });
      }

      const lower = String(file.originalname || "").toLowerCase();
      const isPdf = file.mimetype === "application/pdf" || lower.endsWith(".pdf");
      const isDocx =
        file.mimetype ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        lower.endsWith(".docx");

      const isTex =
        file.mimetype === "application/x-tex" ||
        file.mimetype === "text/x-tex" ||
        lower.endsWith(".tex");

      if (!isPdf && !isDocx && !isTex) {
        return res.status(400).json({ error: "Only .pdf, .docx, and .tex are allowed" });
      }

      if (file.size > 5 * 1024 * 1024) {
        return res.status(413).json({ error: "File too large (max 5MB)" });
      }

      const rawText = await parseResumeTextFromFile({
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname
      });

      if (!rawText || !rawText.trim()) {
        return res.status(422).json({ error: "Could not extract text from resume" });
      }

      const userKeyRow = getUserEncryptedKeyRow(req.userId);
      if (!userKeyRow) {
        return res.status(400).json({ error: "No API key configured" });
      }

      const decryptedApiKey = decryptApiKeyFromAtRestRow(userKeyRow);
      if (!decryptedApiKey) {
        return res.status(500).json({ error: "Failed to decrypt API key" });
      }

      const extracted = await extractProfileFieldsFromResumeText(rawText, decryptedApiKey);


      // Persist per-user profile (best-effort upsert)
      const firstName = extracted?.firstName ? String(extracted.firstName) : "";
      const lastName = extracted?.lastName ? String(extracted.lastName) : "";
      const email = extracted?.email ? String(extracted.email) : "";
      const phone = extracted?.phone ? String(extracted.phone) : "";
      const addressJson = JSON.stringify(extracted?.address ?? {});
      const experienceJson = JSON.stringify(extracted?.experience ?? []);
      const educationJson = JSON.stringify(extracted?.education ?? []);
      const skillsJson = JSON.stringify(extracted?.skills ?? []);
      const updatedAt = new Date().toISOString();

      db.prepare(
        `INSERT INTO profiles (
          userId, firstName, lastName, email, phone,
          addressJson, experienceJson, educationJson, skillsJson, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET
          firstName=excluded.firstName,
          lastName=excluded.lastName,
          email=excluded.email,
          phone=excluded.phone,
          addressJson=excluded.addressJson,
          experienceJson=excluded.experienceJson,
          educationJson=excluded.educationJson,
          skillsJson=excluded.skillsJson,
          updatedAt=excluded.updatedAt`
      ).run(
        req.userId,
        firstName,
        lastName,
        email,
        phone,
        addressJson,
        experienceJson,
        educationJson,
        skillsJson,
        updatedAt
      );

      // Ensure we return JSON object matching requested schema (best-effort).
      return res.json(extracted);
    } catch (err) {
      if (err && err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid request" });
      }

      // multer fileSize limit errors
      if (err && err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File too large (max 5MB)" });
      }

      // Parsing errors (AI JSON)
      console.error("[POST /parse-resume] Error:", err?.response?.data || err);

      const msg = err && err.message ? err.message : "Failed to parse resume";
      return res.status(400).json({ error: msg });
    }
  }
);

const PORT = Number(process.env.PORT) || 4000;

const http = require("http");
const server = http.createServer(app);

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} in use, try a different port`);
    return;
  }
  console.error("Backend server error:", err);
});

server.listen(PORT, () => {
  console.log(`Job Autofill Backend listening at http://localhost:${PORT}`);
});


