let cachedProfile = null;

let FIELD_MAPPING = null;
const FIELD_MAPPINGS_URL = chrome.runtime.getURL("field-mappings.json");

async function loadFieldMappings() {
  if (FIELD_MAPPING) return FIELD_MAPPING;

  const res = await fetch(FIELD_MAPPINGS_URL);
  if (!res.ok) {
    throw new Error(`Failed to load field-mappings.json: ${res.status}`);
  }
  FIELD_MAPPING = await res.json();
  return FIELD_MAPPING;
}

function pickSiteMapping(mappings, hostname) {
  const h = (hostname || "").toLowerCase();

  if (mappings[h]) return mappings[h];

  // Allow subdomains: jobs.greenhouse.io -> greenhouse.io
  for (const key of Object.keys(mappings)) {
    if (key === "default") continue;
    if (h.endsWith(`.${key}`)) return mappings[key];
  }

  return mappings.default || {};
}


const IGNORE_PATTERNS = [
  "salary",
  "compensation",
  "expected salary",
  "current salary",
  "current employer",
  "current company"
];

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    // Remove most punctuation/symbols; keep letters/numbers/space.
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLabelText(input) {
  // Priority: explicit <label for="id">, then closest label wrapper.
  try {
    if (input.id) {
      const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) return l.innerText;
    }
  } catch (e) {
    // ignore
  }

  const parentLabel = input.closest("label");
  if (parentLabel) return parentLabel.innerText;
  return "";
}

function getCandidateSignals(el) {
  const type = (el.type || "").toLowerCase();
  const isSelect = el.tagName.toLowerCase() === "select";

  // Keep signals ordered by priority.
  const signals = [];

  if (el.name) signals.push({ v: el.name, p: 1 });
  if (el.id) signals.push({ v: el.id, p: 2 });

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) signals.push({ v: ariaLabel, p: 3 });

  // Prefer <label for="..."> text when available.
  const labelText = buildLabelText(el);
  if (labelText) signals.push({ v: labelText, p: 4 });

  const placeholder = el.placeholder;
  if (!isSelect && placeholder) signals.push({ v: placeholder, p: 5 });

  // Also include type-specific hints lightly.
  if (type) signals.push({ v: type, p: 6 });

  // Optionally include surrounding text (best-effort) if present.
  const closestField = el.closest("div, section, form, li");
  if (closestField) {
    const txt = closestField.innerText;
    if (txt && txt.length < 300) signals.push({ v: txt, p: 7 });
  }

  return signals;
}


function fieldShouldBeIgnored(normalizedCandidate) {
  const haystack = normalizedCandidate;
  return IGNORE_PATTERNS.some((p) => haystack.includes(normalizeText(p)));
}

function getFieldKeyForElement(el) {
  const signals = getCandidateSignals(el);

  const normalizedParts = signals
    .sort((a, b) => a.p - b.p)
    .map((s) => normalizeText(s.v))
    .filter(Boolean);

  const normalizedCandidate = normalizedParts.join(" ");
  if (!normalizedCandidate) return null;
  if (fieldShouldBeIgnored(normalizedCandidate)) return null;

  const siteMapping = FIELD_MAPPING
    ? pickSiteMapping(FIELD_MAPPING, window.location.hostname)
    : {};

  let bestKey = null;
  let bestScore = 0;

  for (const key of Object.keys(siteMapping)) {
    const patterns = Array.isArray(siteMapping[key]) ? siteMapping[key] : [];
    for (const rawPattern of patterns) {
      const pattern = normalizeText(rawPattern);
      if (!pattern) continue;

      let score = 0;
      if (normalizedCandidate === pattern) score += 5;
      else {
        if (normalizedCandidate.includes(pattern)) score += 2;

        const tokens = pattern.split(" ").filter(Boolean);
        const allTokensPresent =
          tokens.length > 1 && tokens.every((t) => normalizedCandidate.includes(t));
        if (allTokensPresent) score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
  }

  return bestScore >= 2 ? bestKey : null;
}


function isFillableInput(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.type || "").toLowerCase();

  if (tag !== "input" && tag !== "textarea" && tag !== "select") return false;
  if (el.offsetParent === null) return false;

  if (tag === "input" && type === "hidden") return false;
  if (["password", "checkbox", "radio", "file"].includes(type)) return false;

  return true;
}


function setNativeValue(el, value) {
  // Support React-controlled inputs by using the native value setter
  // and dispatching a bubbling input event.
  const prototype = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor && typeof descriptor.set === "function") {
    descriptor.set.call(el, value);
  } else {
    // Fallback.
    el.value = value;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillElement(el, value) {
  if (!value) return false;

  const tag = el.tagName.toLowerCase();
  const type = (el.type || "").toLowerCase();

  const allowedInputTypes = ["text", "email", "tel", "url", "search", "number", "" ];
  const isTextLike = tag === "textarea" || (tag === "input" && allowedInputTypes.includes(type));

  if (tag === "select") {
    // Only set if empty/unset.
    if (el.value && String(el.value).trim().length > 0) return false;
    // Try to match an option by normalized text.
    const wanted = normalizeText(value);
    const options = Array.from(el.options || []);
    const match = options.find((o) => normalizeText(o.value) === wanted || normalizeText(o.textContent) === wanted);
    if (!match) return false;
    el.focus({ preventScroll: true });
    el.value = match.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (!isTextLike) return false;

  // Respect already-filled values.
  if (el.value && String(el.value).trim().length > 0) return false;

  el.focus({ preventScroll: true });
  setNativeValue(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function getFillableElements() {
  return Array.from(document.querySelectorAll("input, textarea, select"))
    .filter(isFillableInput)
    .filter((el) => {
      const type = (el.type || "").toLowerCase();
      if (type === "hidden") return false;
      if (["password", "checkbox", "radio", "file"].includes(type)) return false;
      return true;
    });
}

function showBanner({ filledCount, skippedCount, filledKeys, skippedKeys }) {
  const banner = document.createElement("div");
  const filledPart = `filled ${filledCount}`;
  const skippedPart = `skipped ${skippedCount}`;

  const filledShort = filledKeys && filledKeys.length ? `\nFilled: ${filledKeys.join(", ")}` : "";
  const skippedShort = skippedKeys && skippedKeys.length ? `\nSkipped: ${skippedKeys.join(", ")}` : "";

  banner.textContent = `Job Autofill+: ${filledPart}, ${skippedPart}${filledShort}${skippedShort}`;
  banner.style.position = "fixed";
  banner.style.bottom = "14px";
  banner.style.right = "14px";
  banner.style.zIndex = "2147483647";
  banner.style.padding = "10px 12px";
  banner.style.borderRadius = "10px";
  banner.style.background = "rgba(0, 0, 0, 0.8)";
  banner.style.color = "#fff";
  banner.style.fontSize = "12px";
  banner.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
  banner.style.cursor = "pointer";

  banner.addEventListener("click", () => banner.remove());
  document.documentElement.appendChild(banner);

  setTimeout(() => {
    if (banner.isConnected) banner.remove();
  }, 4000);
}

function autofillForm(profile) {
  if (!profile) return;

  const elements = getFillableElements();
  const filledKeys = [];
  const skippedKeys = [];

  let filledCount = 0;
  let skippedCount = 0;

  for (const el of elements) {
    const key = getFieldKeyForElement(el);
    if (!key) continue;

    const value = profile[key];
    if (!value) {
      skippedCount += 1;
      if (!skippedKeys.includes(key)) skippedKeys.push(key);
      continue;
    }

    const didFill = fillElement(el, value);
    if (didFill) {
      filledCount += 1;
      if (!filledKeys.includes(key)) filledKeys.push(key);
    } else {
      skippedCount += 1;
      if (!skippedKeys.includes(key)) skippedKeys.push(key);
    }
  }

  // Heuristic marker: remember that we likely just filled a job application form.
  // This is later used to decide whether a subsequent real submit is an "application".
  if (filledCount > 0) {
    try {
      window.__jaflLastAutofill = {
        ts: Date.now(),
        url: window.location.href,
        hostname: window.location.hostname,
        filledCount,
        filledKeys: filledKeys.slice(0, 10)
      };
    } catch (_) {
      // ignore
    }

    showBanner({
      filledCount,
      skippedCount,
      filledKeys: filledKeys.slice(0, 6),
      skippedKeys: skippedKeys.slice(0, 6)
    });
  }
}



function isSiteEnabled(cb) {
  chrome.storage.sync.get("siteSettings", (data) => {
    const siteSettings = data.siteSettings || {};
    const domain = window.location.hostname;
    const enabled = siteSettings[domain] !== false; // default enabled
    cb(enabled);
  });
}

function loadProfileAndAutofill() {
  chrome.storage.sync.get(["jobProfiles", "activeProfileId"], (data) => {
    const jobProfiles = Array.isArray(data.jobProfiles) ? data.jobProfiles : [];
    const activeId = data.activeProfileId;

    const active = jobProfiles.find((p) => p.id === activeId) || jobProfiles[0] || null;
    cachedProfile = active ? active.data : null;

    if (cachedProfile) autofillForm(cachedProfile);
  });
}

function runIfEnabled() {
  isSiteEnabled((enabled) => {
    if (!enabled) return;

    // Load field-mappings.json first so matching is correct.
    (async () => {
      try {
        await loadFieldMappings();
      } catch (e) {
        console.error("Failed to load field-mappings.json, using empty mapping:", e);
        FIELD_MAPPING = { default: {} };
      }

      loadProfileAndAutofill();
    })();


    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (cachedProfile) autofillForm(cachedProfile);
        else loadProfileAndAutofill();
      }, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    function safeInnerText(el) {
      return el ? (el.innerText || el.textContent || "").trim() : "";
    }


function normalizeSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function extractCompanyAndTitleHeuristically() {
  // Best-effort extraction from common patterns.
  const url = window.location.href;

  // Title: try multiple common selectors.
  const titleSelectors = [
    "h1",
    "h1[role='heading']",
    "h1[class*='title' i]",
    "header h1",
    "[data-testid*='job-title' i]",
    "[class*='job-title' i]",
    "[id*='job-title' i]"
  ];

  const titleEl = titleSelectors.map((sel) => document.querySelector(sel)).find(Boolean);
  const pageTitle = safeInnerText(titleEl) || document.title || "";
  const cleanedTitle = normalizeSpace(pageTitle);

  // Company: try a few common places.
  const companySelectors = [
    "[data-testid*='company' i]",
    "[class*='company' i]",
    "[id*='company' i]",
    "a[href*='company']",
    "[aria-label*='company' i]"
  ];
  const companyEl = companySelectors.map((sel) => document.querySelector(sel)).find(Boolean);
  const companyGuess = normalizeSpace(safeInnerText(companyEl));

  // Some pages use "Role - Company" in the header; parse if company missing.
  let jobTitle = cleanedTitle;
  let company = companyGuess;

  if (!company && cleanedTitle.includes(" - ")) {
    const parts = cleanedTitle.split(" - ");
    if (parts.length >= 2) {
      jobTitle = normalizeSpace(parts[0]);
      company = normalizeSpace(parts.slice(1).join(" - "));
    }
  }

  // If jobTitle looks like a full page title with separators, keep it but avoid "Home |" style.
  if (jobTitle.length > 120) jobTitle = jobTitle.slice(0, 120);

  return {
    jobTitle: jobTitle || "",
    company: company || "",
    url
  };
}

function isPlausibleApplicationForm(form) {
  if (!form) return false;

  // Basic signals near the submit button.
  const formText = normalizeSpace(form.innerText || "");
  const lower = formText.toLowerCase();
  const hasApplyWord =
    lower.includes("apply") ||
    lower.includes("submit") ||
    lower.includes("send") ||
    lower.includes("application");

  // Form should contain something like inputs.
  const hasFormFields = !!form.querySelector("input, textarea, select");

  return hasApplyWord || hasFormFields;
}

function getLastAutofillMarker() {
  try {
    return window.__jaflLastAutofill || null;
  } catch (_) {
    return null;
  }
}

const SUBMIT_WINDOW_MS = 30000; // 30s after we autofilled
const HISTORY_DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10m

async function appendAppliedJobToHistory(record) {
  if (!record) return;

  chrome.storage.local.get(["appliedJobs"], (data) => {
    const arr = Array.isArray(data.appliedJobs) ? data.appliedJobs : [];

    const url = record.url || "";
    const jobTitle = record.jobTitle || "";

    const now = Date.now();

    // Lightweight de-dup: if same url appears recently, skip.
    const maybeDuplicate = arr.some((x) => {
      if (!x || !x.url) return false;
      const xTime = typeof x.dateApplied === "number" ? x.dateApplied : Date.parse(x.dateApplied);
      const age = Number.isFinite(xTime) ? Math.abs(now - xTime) : Infinity;
      const sameUrl = x.url === url;
      const sameTitle = !jobTitle || x.jobTitle === jobTitle;
      return sameUrl && sameTitle && age <= HISTORY_DEDUP_WINDOW_MS;
    });

    if (maybeDuplicate) return;

    arr.push({
      jobTitle: record.jobTitle || "",
      company: record.company || "",
      url: record.url || "",
      dateApplied: now
    });

    // Keep bounded.
    const bounded = arr
      .sort((a, b) => {
        const ta = typeof a.dateApplied === "number" ? a.dateApplied : Date.parse(a.dateApplied);
        const tb = typeof b.dateApplied === "number" ? b.dateApplied : Date.parse(b.dateApplied);
        return tb - ta;
      })
      .slice(0, 200);

    chrome.storage.local.set({ appliedJobs: bounded });
  });
}

function resolveJobRecordFromDOM() {
  const { jobTitle, company, url } = extractCompanyAndTitleHeuristically();

  // If extraction is too empty, fall back to document title only.
  return {
    jobTitle: jobTitle || document.title || "",
    company: company || "",
    url: url || window.location.href
  };
}

function shouldRecordSubmit() {
  const marker = getLastAutofillMarker();
  if (!marker || !marker.ts) return false;

  const age = Date.now() - marker.ts;
  if (age < 0 || age > SUBMIT_WINDOW_MS) return false;

  // Same page/url (best-effort). Allow minor hash changes.
  const markerUrl = String(marker.url || "");
  const currentUrl = String(window.location.href || "");
  if (marker.hostname && marker.hostname !== window.location.hostname) return false;

  if (markerUrl && currentUrl) {
    // Allow hash changes by ignoring fragment.
    const markerNoHash = markerUrl.split("#")[0];
    const currentNoHash = currentUrl.split("#")[0];
    if (markerNoHash && currentNoHash && markerNoHash !== currentNoHash) return false;
  }

  return true;
}

function installSubmitDetectionOnce() {
  if (window.__jaflSubmitHookInstalled) return;
  window.__jaflSubmitHookInstalled = true;

  document.addEventListener(
    "submit",
    (e) => {
      try {
        if (!shouldRecordSubmit()) return;

        const form = e.target && e.target.tagName && e.target.tagName.toLowerCase() === "form" ? e.target : null;
        if (form && !isPlausibleApplicationForm(form)) return;

        // We record best-effort extracted info.
        const record = resolveJobRecordFromDOM();
        if (!record.url) return;

        appendAppliedJobToHistory(record);

        // Clear marker so we don't record multiple submits.
        window.__jaflLastAutofill = null;
      } catch (err) {
        console.error("[Job Autofill+] submit hook error", err);
      }
    },
    true
  );
}

function installManualMarkAppliedListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "FILL_NOW") {
      if (message.profile) {
        cachedProfile = message.profile;
      }
      if (!cachedProfile) {
        sendResponse({ ok: false, error: "No active profile" });
        return true;
      }
      autofillForm(cachedProfile);
      sendResponse({ ok: true });
      return true;
    }

    if (message && message.type === "MARK_APPLIED") {
      try {
        const record = resolveJobRecordFromDOM();
        appendAppliedJobToHistory(record);
        window.__jaflLastAutofill = null;
        sendResponse({ ok: true });
      } catch (err) {
        console.error("[Job Autofill+] MARK_APPLIED error", err);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
      return true;
    }

    return false;
  });
}

    installSubmitDetectionOnce();
    installManualMarkAppliedListener();
  });
}

runIfEnabled();


