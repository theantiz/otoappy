require("dotenv").config();

const express = require("express");
const cors = require("cors");

const setupDb = require("./db");

const buildAuthRoutes = require("./routes/auth");
const buildProfileRoutes = require("./routes/profile");
const buildAccountRoutes = require("./routes/account");
const buildCoverLetterRoutes = require("./routes/coverLetter");
const buildParseResumeRoutes = require("./routes/parseResume");

module.exports = function createApp() {
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

  const db = setupDb();

  const JWT_SECRET = process.env.JWT_SECRET;
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

  const { router: authRouter, requireAuth } = buildAuthRoutes({ db, JWT_SECRET });
  app.use("/auth", authRouter);

  const profileRoutes = buildProfileRoutes({ db, requireAuth });
  app.use("/profile", profileRoutes);

  const accountBuild = buildAccountRoutes({ db, requireAuth, ENCRYPTION_KEY });
  app.use("/account", accountBuild.router);

  const coverLetterRoutes = buildCoverLetterRoutes({
    requireAuth,
    getUserEncryptedKeyRow: accountBuild.getUserEncryptedKeyRow,
    decryptApiKeyFromAtRestRow: accountBuild.decryptApiKeyFromAtRestRow
  });
  app.use("/", coverLetterRoutes);

  const parseResumeRoutes = buildParseResumeRoutes({
    db,
    requireAuth,
    getUserEncryptedKeyRow: accountBuild.getUserEncryptedKeyRow,
    decryptApiKeyFromAtRestRow: accountBuild.decryptApiKeyFromAtRestRow
  });

  app.use("/", parseResumeRoutes);

  return app;
};

