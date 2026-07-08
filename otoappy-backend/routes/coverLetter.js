const express = require("express");


function buildGenerateCoverLetter() {
  return async function generateCoverLetter({ profileData, jobContext, apiKey }) {
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

    return response.data?.choices?.[0]?.message?.content || "";
  };
}

module.exports = function buildCoverLetterRoutes({ requireAuth, getUserEncryptedKeyRow, decryptApiKeyFromAtRestRow }) {
  const router = express.Router();
  const generateCoverLetter = buildGenerateCoverLetter();

  router.post("/generate-cover", requireAuth, async (req, res) => {
    try {
      const { profileData, jobContext } = req.body || {};

      if (!profileData) {
        return res.status(400).json({ error: "profileData is required" });
      }

      const userKeyRow = getUserEncryptedKeyRow({ userId: req.userId });
      if (!userKeyRow) {
        return res.status(400).json({ error: "No API key configured" });
      }

      const decryptedApiKey = decryptApiKeyFromAtRestRow({ row: userKeyRow });
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

  return router;
};

