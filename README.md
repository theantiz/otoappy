# Otoappy

**Apply once. Everywhere.**

Otoappy is an AI-powered Chrome extension that automates job application forms. Upload your resume once, and Otoappy fills out applications across job platforms — Greenhouse, Lever, Workday, LinkedIn Easy Apply, and more — automatically, with AI-generated cover letters tailored to each listing.

---

## Features

- **One-time resume upload** — Upload a PDF, DOCX, or LaTeX (`.tex`) resume once. Otoappy extracts your details (name, contact info, experience, education, skills) automatically using AI.
- **Smart autofill** — Detects and fills form fields across inconsistent ATS platforms using multi-signal matching (labels, names, IDs, placeholders), including support for React-controlled forms.
- **AI-tailored cover letters** — Generates a cover letter customized to each job listing by reading the job title, company, and description directly from the page.
- **Bring your own API key (BYOK)** — Connect your own AI provider API key. Your key is encrypted at rest and never exposed to the frontend after saving.
- **User accounts** — Secure signup/login so your profile and resume data persist across sessions and devices.
- **Application tracking** — Keep a log of jobs you've applied to, directly from the extension.
- **Per-site configuration** — Field-mapping logic is externalized, making it easy to extend support to new ATS platforms without touching core code.

---

## Project Structure

```
otoappy/
├── otoappy-extension/      # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js          # Field detection + autofill engine
│   ├── popup.html
│   ├── popup.js
│   └── field-mappings.json # Per-site ATS field mapping config
│
└── otoappy-backend/         # Node.js / Express backend
    ├── index.js
    ├── routes/
    │   ├── auth.js          # Signup / login / JWT middleware
    │   ├── profile.js       # Profile storage & retrieval
    │   ├── parseResume.js   # PDF / DOCX / TEX parsing → structured profile
    │   ├── coverLetter.js   # AI cover letter generation
    │   └── account.js       # API key management (BYOK)
    └── db/                  # Database schema & migrations
```

---

## Tech Stack

**Extension**
- Manifest V3
- Vanilla JS (content scripts, popup UI)
- `chrome.storage.local` for session/token persistence

**Backend**
- Node.js + Express
- PostgreSQL (or SQLite for local dev) for user/profile storage
- `multer` — file upload handling
- `pdf-parse` / `mammoth` — PDF and DOCX text extraction
- `bcrypt` + `jsonwebtoken` — authentication
- AES-256-GCM encryption for stored user API keys
- User-supplied AI provider API key (BYOK) for parsing & generation

---

## Getting Started

### Prerequisites
- Node.js ≥ 18
- npm
- A PostgreSQL instance (or SQLite for local development)

### Backend setup

```bash
cd otoappy-backend
npm install
cp .env.example .env   # fill in JWT_SECRET, ENCRYPTION_KEY, DB connection string
npm run dev
```

### Extension setup

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `otoappy-extension/` folder.
4. Pin the extension and click the icon to sign up / log in.

### Environment variables (backend `.env`)

| Variable | Description |
|---|---|
| `PORT` | Backend server port |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used to sign auth tokens |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting stored user API keys (generate via `openssl rand -hex 32`) |

---

## 🔒 Privacy & Data

Otoappy stores:
- Account email + hashed password
- Parsed resume/profile data (used to fill forms)
- An encrypted copy of your AI provider API key (used server-side only, never returned to the client)

No resume data or API key is shared with third parties beyond the AI provider call required to generate parsed profiles and cover letters.

---

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a pull request.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Open a pull request