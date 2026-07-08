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
    const str = String(jsonText || "");
    const match = str.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(stripMarkdownFences(match[0]));
    }
    throw e;
  }
}

module.exports = {
  stripMarkdownFences,
  safeParseJson
};

