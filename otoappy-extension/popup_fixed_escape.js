// job-autofill-extension/popup.js (escapeHtml fixed)
// NOTE: This file is a temporary working copy used to validate syntax.

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/\"/g, """)
    .replace(/'/g, "&#039;");
}

module.exports = { escapeHtml };

