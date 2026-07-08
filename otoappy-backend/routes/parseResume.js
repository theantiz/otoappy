const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const axios = require("axios");

const { safeParseJson } = require("../utils/json");


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

module.exports = function buildParseResumeRoutes({ db, requireAuth, getUserEncryptedKeyRow, decryptApiKeyFromAtRestRow }) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024
    }
  });

  router.post("/parse-resume", requireAuth, upload.single("resume"), async (req, res) => {
    try {
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "resume file is required" });
      }

      const lower = String(file.originalname || "").toLowerCase();
      const isPdf = file.mimetype === "application/pdf" || lower.endsWith(".pdf");
      const isDocx =
        file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
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

      const userKeyRow = getUserEncryptedKeyRow({ userId: req.userId });
      if (!userKeyRow) {
        return res.status(400).json({ error: "No API key configured" });
      }

      const decryptedApiKey = decryptApiKeyFromAtRestRow({ row: userKeyRow });
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

      return res.json(extracted);
    } catch (err) {
      if (err && err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid request" });
      }

      // multer fileSize limit errors
      if (err && err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File too large (max 5MB)" });
      }

      console.error("[POST /parse-resume] Error:", err?.response?.data || err);

      const msg = err && err.message ? err.message : "Failed to parse resume";
      return res.status(400).json({ error: msg });
    }
  });


  return router;
};

