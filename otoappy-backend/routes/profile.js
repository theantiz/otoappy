const express = require("express");

module.exports = function buildProfileRoutes({ db, requireAuth }) {
  const router = express.Router();

  router.get("/", requireAuth, (req, res) => {
    const row = db
      .prepare(
        "SELECT firstName, lastName, email, phone, addressJson, experienceJson, educationJson, skillsJson, updatedAt FROM profiles WHERE userId = ?"
      )
      .get(req.userId);

    if (!row) {
      return res.json(null);
    }

    const address = (() => {
      try {
        return JSON.parse(row.addressJson || "{}");
      } catch {
        return {};
      }
    })();

    const experience = (() => {
      try {
        return JSON.parse(row.experienceJson || "[]");
      } catch {
        return [];
      }
    })();

    const education = (() => {
      try {
        return JSON.parse(row.educationJson || "[]");
      } catch {
        return [];
      }
    })();

    const skills = (() => {
      try {
        return JSON.parse(row.skillsJson || "[]");
      } catch {
        return [];
      }
    })();

    return res.json({
      firstName: row.firstName || "",
      lastName: row.lastName || "",
      email: row.email || "",
      phone: row.phone || "",
      address,
      experience,
      education,
      skills,
      updatedAt: row.updatedAt || ""
    });
  });

  return router;
};

