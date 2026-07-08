// job-autofill-extension/popup.js

const PROFILE_FIELDS = [
  "profileName",
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "address",
  "location",
  "headline",
  "currentCompany",
  "website",
  "github",
  "linkedin",
  "twitter",
  "pronouns",
  "workAuthorization",
  "sponsorship",
  "whyRole",
  "aboutMe",
  "coverLetter"
];

let profiles = [];
let activeProfileId = null;
let currentDomain = null;

const BACKEND_URL = "http://localhost:4000";

const AUTH_STORAGE_KEYS = ["authToken", "authUserId"];

function showAuthView() {
  const authView = $("authView");
  const mainView = $("mainView");
  if (authView) authView.style.display = "block";
  if (mainView) mainView.style.display = "none";
}

function showMainView() {
  const authView = $("authView");
  const mainView = $("mainView");
  if (authView) authView.style.display = "none";
  if (mainView) mainView.style.display = "block";
}

function setAuthError(msg) {
  const el = $("authError");
  if (el) el.textContent = msg || "";
}

async function withAuthToken(fn) {
  return new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEYS, async (data) => {
      const token = data.authToken;
      const userId = data.authUserId;
      resolve(await fn({ token, userId }));
    });
  });
}

async function authedFetch(path, { method, body, isJson = true }) {
  return withAuthToken(async ({ token }) => {
    if (!token) return { ok: false, status: 401, data: null, rawText: "" };

    const headers = {};
    if (isJson) headers["Content-Type"] = "application/json";
    headers.Authorization = `Bearer ${token}`;

    const resp = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers,
      body: body ? (isJson ? JSON.stringify(body) : body) : undefined
    });

    const rawText = await resp.text().catch(() => "");
    let data = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        // ignore
      }
    }

    return { ok: resp.ok, status: resp.status, data, rawText };
  });
}

function clearAuth() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(["authToken", "authUserId"], () => resolve());
  });
}

async function tryEnsureAuthOrShowLogin() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken", "authUserId"], async (data) => {
      const token = data.authToken;
      const userId = data.authUserId;

      if (!token || !userId) {
        setAuthError("");
        showAuthView();
        resolve(false);
        return;
      }

      // We only trust the token if we can make at least one protected call.
      // Use a lightweight protected request.
      // NOTE: If backend returns 401, we clear storage and show login.
      try {
        const resp = await fetch(`${BACKEND_URL}/`, {
          method: "GET",
          headers: {
            Authorization: "Bearer " + token
          }
        });


        if (resp.status === 401) {
          await handleApi401AndRecover();
          resolve(false);
          return;
        }

        // Some backend setups may ignore auth on '/'. We accept non-401 responses
        // as “token present”; protected endpoints will still enforce correctness later.
        showMainView();
        resolve(true);
      } catch {
        // Network failure: keep UI available (token may be valid)
        showMainView();
        resolve(true);
      }
    });
  });
}


async function authenticate(action) {
  const email = $("authEmail")?.value?.trim();
  const password = $("authPassword")?.value;

  if (!email || !password) {
    setAuthError("Email and password are required");
    return;
  }

  setAuthError("");

  try {
    const endpoint = action === "signup" ? "/auth/signup" : "/auth/login";

    const resp = await fetch(`${BACKEND_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    const rawText = await resp.text().catch(() => "");
    let data = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        // ignore
      }
    }

    if (!resp.ok) {
      const msg = data?.error || "Authentication failed";
      setAuthError(msg);
      return;
    }

    if (!data?.token || !data?.userId) {
      setAuthError("Invalid auth response");
      return;
    }

    await new Promise((resolve) => {
      chrome.storage.local.set({ authToken: data.token, authUserId: data.userId }, () => resolve());
    });

    setAuthError("");
    showMainView();

    // Load profiles UI only after login
    refreshProfileUI();
  } catch (err) {
    console.error(err);
    setAuthError("Authentication failed");
  }
}

async function handleApi401AndRecover() {
  await clearAuth();
  setAuthError("");
  showAuthView();
}


function generateId() {
  return "p_" + Math.random().toString(36).slice(2, 10);
}

function $(id) {
  return document.getElementById(id);
}

function setStatus(msg, timeout = 2200) {
  const el = $("status");
  if (!el) return;
  el.textContent = msg;
  if (timeout) {
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = "";
    }, timeout);
  }
}

function loadProfilesFromStorage(cb) {
  chrome.storage.sync.get(["jobProfiles", "activeProfileId", "siteSettings"], (data) => {
    profiles = Array.isArray(data.jobProfiles) ? data.jobProfiles : [];
    activeProfileId = data.activeProfileId || (profiles[0] && profiles[0].id) || null;
    cb && cb(data.siteSettings || {});
  });
}

function saveProfilesToStorage() {
  chrome.storage.sync.set({ jobProfiles: profiles, activeProfileId });
}

function getActiveProfile() {
  return profiles.find((p) => p.id === activeProfileId) || null;
}

function populateProfileSelect() {
  const select = $("profileSelect");
  select.innerHTML = "";

  if (profiles.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No profiles yet";
    select.appendChild(opt);
    return;
  }

  profiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.data.profileName || "Unnamed profile";
    if (p.id === activeProfileId) opt.selected = true;
    select.appendChild(opt);
  });
}

function loadProfileIntoForm(profile) {
  if (!profile) {
    PROFILE_FIELDS.forEach((key) => {
      const el = $(key);
      if (el) el.value = "";
    });
    return;
  }

  PROFILE_FIELDS.forEach((key) => {
    const el = $(key);
    if (!el) return;
    el.value = profile.data[key] || "";
  });
}

function readProfileFromForm() {
  const data = {};
  PROFILE_FIELDS.forEach((key) => {
    const el = $(key);
    data[key] = el ? el.value.trim() : "";
  });

  if (!data.profileName) data.profileName = "General";
  return data;
}

function refreshProfileUI() {
  populateProfileSelect();
  loadProfileIntoForm(getActiveProfile());
}

function initSiteToggle(siteSettings) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) return;

    try {
      const urlObj = new URL(tab.url);
      currentDomain = urlObj.hostname;
    } catch {
      currentDomain = null;
    }

    $("currentDomain").textContent = currentDomain || "";

    const enableSiteCheckbox = $("enableSite");
    if (!currentDomain) {
      enableSiteCheckbox.checked = false;
      enableSiteCheckbox.disabled = true;
      return;
    }

    const isEnabled = siteSettings[currentDomain] !== false;
    enableSiteCheckbox.checked = isEnabled;

    enableSiteCheckbox.addEventListener("change", () => {
      const enabled = enableSiteCheckbox.checked;
      chrome.storage.sync.get("siteSettings", (data) => {
        const updated = data.siteSettings || {};
        if (!enabled) updated[currentDomain] = false;
        else delete updated[currentDomain];
        chrome.storage.sync.set({ siteSettings: updated });
      });
    });
  });
}

function onProfileSelectChange() {
  const newId = $("profileSelect").value;
  if (!newId) return;
  activeProfileId = newId;
  saveProfilesToStorage();
  loadProfileIntoForm(getActiveProfile());
}

function onNewProfile() {
  const newProfile = {
    id: generateId(),
    data: {
      profileName: "New profile",
      firstName: "",
      lastName: "",
      fullName: "",
      email: "",
      phone: "",
      address: "",
      location: "",
      headline: "",
      currentCompany: "",
      website: "",
      github: "",
      linkedin: "",
      twitter: "",
      pronouns: "",
      workAuthorization: "",
      sponsorship: "",
      whyRole: "",
      aboutMe: "",
      coverLetter: ""
    }
  };

  profiles.push(newProfile);
  activeProfileId = newProfile.id;
  saveProfilesToStorage();
  refreshProfileUI();
}

function onSaveProfile() {
  const data = readProfileFromForm();

  if (!activeProfileId) {
    profiles.push({ id: generateId(), data });
    activeProfileId = profiles[profiles.length - 1].id;
  } else {
    const idx = profiles.findIndex((p) => p.id === activeProfileId);
    if (idx === -1) profiles.push({ id: activeProfileId, data });
    else profiles[idx].data = data;
  }

  saveProfilesToStorage();
  refreshProfileUI();
  setStatus("Profile saved");
}

function onFillNow() {
  const profile = getActiveProfile();
  if (!profile) {
    setStatus("Create a profile first");
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) {
      setStatus("No active tab");
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: "FILL_NOW", profile: profile.data }, () => {
      setStatus("Fill command sent");
    });
  });
}

async function generateCoverLetterViaBackend(profileData, jobContext) {
  return withAuthToken(async ({ token }) => {
    const resp = await fetch(`${BACKEND_URL}/generate-cover`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ profileData, jobContext })
    });

    if (resp.status === 401) {
      await handleApi401AndRecover();
      throw new Error("Unauthorized");
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Backend error: ${resp.status} ${text}`);
    }

    const data = await resp.json();
    if (!data || typeof data.coverLetter !== "string")
      throw new Error("Invalid backend response");
    return data.coverLetter;
  });
}


function inferRoleAndCompanyFromTabTitle(tabTitle) {
  const title = (tabTitle || "").trim();
  const parts = title.split(" - ");

  if (parts.length >= 2) {
    return { role: parts[0].trim(), company: parts.slice(1).join(" - ").trim() };
  }

  return { role: title, company: "" };
}

async function onGenerateCoverLetter() {
  const active = getActiveProfile();
  if (!active) {
    setStatus("Create a profile first");
    return;
  }

  const profileData = readProfileFromForm();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];

  const { role, company } = inferRoleAndCompanyFromTabTitle(tab ? tab.title : "");
  setStatus("Generating cover letter…", 0);

  try {
    const coverLetter = await generateCoverLetterViaBackend(profileData, { role, company });
    $("coverLetter").value = coverLetter;

    const idx = profiles.findIndex((p) => p.id === activeProfileId);
    if (idx !== -1) profiles[idx].data.coverLetter = coverLetter;
    saveProfilesToStorage();

    setStatus("Cover letter generated");
  } catch (err) {
    console.error(err);
    setStatus("Failed to generate cover letter");
  }
}

function formatDate(ts) {
  try {
    if (!ts) return "";
    const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  } catch {
    return "";
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/\"/g, "")
    .replace(/'/g, "&#039;");
}

function loadAppliedJobs(cb) {
  chrome.storage.local.get(["appliedJobs"], (data) => {
    const arr = Array.isArray(data.appliedJobs) ? data.appliedJobs : [];
    arr.sort((a, b) => {
      const ta = typeof a.dateApplied === "number" ? a.dateApplied : Date.parse(a.dateApplied);
      const tb = typeof b.dateApplied === "number" ? b.dateApplied : Date.parse(b.dateApplied);
      return tb - ta;
    });
    cb && cb(arr);
  });
}

function renderHistory(appliedJobs) {
  const list = $("historyList");
  const empty = $("historyEmpty");
  if (!list || !empty) return;

  list.innerHTML = "";

  if (!appliedJobs || appliedJobs.length === 0) {
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";

  appliedJobs.forEach((job, idx) => {
    const row = document.createElement("div");
    row.style.border = "1px solid var(--border)";
    row.style.borderRadius = "12px";
    row.style.padding = "10px";
    row.style.marginBottom = "10px";
    row.style.background = "#fff";

    const title = job.jobTitle ? job.jobTitle : "(Untitled job)";
    const company = job.company ? job.company : "";
    const when = formatDate(job.dateApplied);

    row.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
        <div style="min-width:0;">
          <div style="font-weight:800; font-size:13px; line-height:1.2;">${escapeHtml(title)}</div>
          ${company ? `<div style="color: var(--muted); font-size:12px; margin-top:3px;">${escapeHtml(company)}</div>` : ""}
          <div style="color: var(--muted); font-size:11.5px; margin-top:5px;">${escapeHtml(when)}</div>
          ${job.url ? `<div style="margin-top:6px;"><a href="${escapeHtml(job.url)}" target="_blank" rel="noreferrer" style="color: var(--primary); text-decoration:none; font-size:11.5px;">Open link</a></div>` : ""}
        </div>
        <button data-index="${idx}" class="btnGhost" style="width:auto; margin-top:0; border-radius:10px; padding:8px 10px; border-color: rgba(239, 68, 68, 0.35); color: var(--danger); background: rgba(239, 68, 68, 0.08);">Delete</button>
      </div>
    `;

    const btn = row.querySelector("button[data-index]");
    btn.addEventListener("click", () => {
      const index = Number(btn.getAttribute("data-index"));
      if (!Number.isFinite(index)) return;

      chrome.storage.local.get(["appliedJobs"], (data) => {
        const arr = Array.isArray(data.appliedJobs) ? data.appliedJobs : [];
        arr.sort((a, b) => {
          const ta = typeof a.dateApplied === "number" ? a.dateApplied : Date.parse(a.dateApplied);
          const tb = typeof b.dateApplied === "number" ? b.dateApplied : Date.parse(b.dateApplied);
          return tb - ta;
        });
        arr.splice(index, 1);
        chrome.storage.local.set({ appliedJobs: arr }, () => loadAppliedJobs(renderHistory));
      });
    });

    list.appendChild(row);
  });
}

function onShowApplyTab() {
  const applyTab = $("applyTab");
  const historyTab = $("historyTab");
  if (applyTab) applyTab.style.display = "block";
  if (historyTab) historyTab.style.display = "none";
}

function onShowHistoryTab() {
  const applyTab = $("applyTab");
  const historyTab = $("historyTab");
  if (applyTab) applyTab.style.display = "none";
  if (historyTab) historyTab.style.display = "block";
  loadAppliedJobs((jobs) => renderHistory(jobs));
}

function onMarkApplied() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      setStatus("No active tab");
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: "MARK_APPLIED" }, (resp) => {
      if (resp && resp.ok) setStatus("Marked as applied");
      else setStatus(resp && resp.error ? resp.error : "Failed to mark as applied");
    });
  });
}

async function parseResumeViaBackend(file) {
  const formData = new FormData();
  formData.append("resume", file);

  return withAuthToken(async ({ token }) => {
    const resp = await fetch(`${BACKEND_URL}/parse-resume`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: formData
    });

    if (resp.status === 401) {
      await handleApi401AndRecover();
      throw new Error("Unauthorized");
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Backend error: ${resp.status} ${text}`);
    }

    return await resp.json();
  });
}


function setResumeParseError(msg) {
  const el = $("resumeParseError");
  if (!el) return;
  el.textContent = msg || "";
}

function setParseResumeButtonLoading(loading) {
  const btn = $("parseResumeBtn");
  if (!btn) return;
  btn.disabled = !!loading;
  btn.textContent = loading ? "Parsing…" : "Parse & Fill Profile";
}

function setProfileFormFromParsedData(parsed) {
  const firstName = parsed?.firstName ? String(parsed.firstName) : "";
  const lastName = parsed?.lastName ? String(parsed.lastName) : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  if ($("firstName")) $("firstName").value = firstName;
  if ($("lastName")) $("lastName").value = lastName;
  if ($("fullName")) $("fullName").value = fullName;
  $("email").value = parsed?.email ? String(parsed.email) : "";
  $("phone").value = parsed?.phone ? String(parsed.phone) : "";

  const addr = parsed?.address || {};
  const street = addr?.street ? String(addr.street) : "";
  const city = addr?.city ? String(addr.city) : "";
  const state = addr?.state ? String(addr.state) : "";
  const zip = addr?.zip ? String(addr.zip) : "";
  const country = addr?.country ? String(addr.country) : "";

  const addressLine = [street, city, state, zip, country].filter(Boolean).join(", ");
  $("address").value = addressLine;
  $("location").value = [city, state].filter(Boolean).join(", ");
}

async function prefillFormFromServerProfile(profile) {
  if (!profile) return;

  const firstName = profile?.firstName ? String(profile.firstName) : "";
  const lastName = profile?.lastName ? String(profile.lastName) : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  // Overwrite existing inputs (returning user behavior)
  if ($("firstName")) $("firstName").value = firstName;
  if ($("lastName")) $("lastName").value = lastName;
  if ($("fullName")) $("fullName").value = fullName;
  $("email").value = profile?.email ? String(profile.email) : "";
  $("phone").value = profile?.phone ? String(profile.phone) : "";

  const addr = profile?.address || {};
  const street = addr?.street ? String(addr.street) : "";
  const city = addr?.city ? String(addr.city) : "";
  const state = addr?.state ? String(addr.state) : "";
  const zip = addr?.zip ? String(addr.zip) : "";
  const country = addr?.country ? String(addr.country) : "";

  const addressLine = [street, city, state, zip, country].filter(Boolean).join(", ");
  $("address").value = addressLine;

  $("location").value = [city, state].filter(Boolean).join(", ");
}

async function fetchProfileFromBackend() {
  return withAuthToken(async ({ token }) => {
    if (!token) return null;

    const resp = await fetch(`${BACKEND_URL}/profile`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (resp.status === 401) {
      await handleApi401AndRecover();
      throw new Error("Unauthorized");
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Backend error: ${resp.status} ${text}`);
    }

    // Returns null when no profile saved
    const data = await resp.json().catch(() => null);
    return data;
  });
}

async function onParseResumeClick() {
  setResumeParseError("");

  const input = $("resumeUpload");
  const file = input?.files && input.files[0];
  if (!file) {
    setResumeParseError("Select a PDF or .docx resume first.");
    return;
  }

  const isAllowedType =
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file.name.toLowerCase().endsWith(".docx");

  if (!isAllowedType) {
    setResumeParseError("Invalid file type. Upload a .pdf or .docx.");
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    setResumeParseError("File too large. Max size is 5MB.");
    return;
  }

  setParseResumeButtonLoading(true);

  try {
    const parsed = await parseResumeViaBackend(file);
    setProfileFormFromParsedData(parsed);
    setStatus("Profile fields parsed. Review before saving.");
  } catch (err) {
    console.error(err);
    setResumeParseError(err && err.message ? err.message : "Failed to parse resume.");
  } finally {
    setParseResumeButtonLoading(false);
  }
}

async function fetchApiKeyStatus() {
  const el = $("apiKeyStatus");
  const errEl = $("apiKeyError");
  if (!el) return;

  errEl && (errEl.textContent = "");

  return withAuthToken(async ({ token }) => {
    if (!token) {
      el.textContent = "Not Connected";
      return;
    }

    const resp = await fetch(`${BACKEND_URL}/account/api-key/status`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (resp.status === 401) {
      await handleApi401AndRecover();
      el.textContent = "Not Connected";
      return;
    }

    if (!resp.ok) {
      el.textContent = "Not Connected";
      return;
    }

    const data = await resp.json().catch(() => null);
    el.textContent = data?.hasKey ? "Connected" : "Not Connected";
  });
}

async function saveApiKeyFromInput() {
  const input = $("apiKeyInput");
  const errEl = $("apiKeyError");
  if (!input) return;

  const apiKey = input.value;
  const s = String(apiKey || "").trim();

  if (!s) {
    errEl && (errEl.textContent = "API key is required");
    return;
  }

  errEl && (errEl.textContent = "");

  return withAuthToken(async ({ token }) => {
    if (!token) return;

    const resp = await fetch(`${BACKEND_URL}/account/api-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ apiKey: s })
    });

    if (resp.status === 401) {
      await handleApi401AndRecover();
      return;
    }

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      errEl && (errEl.textContent = data?.error || "Failed to save API key");
      return;
    }

    input.value = "";
    await fetchApiKeyStatus();
    errEl && (errEl.textContent = "");
  });
}

async function removeApiKey() {
  const errEl = $("apiKeyError");
  errEl && (errEl.textContent = "");

  return withAuthToken(async ({ token }) => {
    if (!token) return;

    const resp = await fetch(`${BACKEND_URL}/account/api-key`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (resp.status === 401) {
      await handleApi401AndRecover();
      return;
    }

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      errEl && (errEl.textContent = data?.error || "Failed to remove API key");
      return;
    }

    await fetchApiKeyStatus();
    errEl && (errEl.textContent = "");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Auth buttons

  const loginBtn = $("authLoginBtn");
  const signupBtn = $("authSignupBtn");

  if (loginBtn) loginBtn.addEventListener("click", () => authenticate("login"));
  if (signupBtn) signupBtn.addEventListener("click", () => authenticate("signup"));

  const logoutBtn = $("logoutBtn");
  if (logoutBtn)
    logoutBtn.addEventListener("click", async () => {
      await clearAuth();
      setAuthError("");
      showAuthView();
    });

  // Auth gate for main UI
  tryEnsureAuthOrShowLogin().then((ok) => {
    if (!ok) return;
    loadProfilesFromStorage((siteSettings) => {
      refreshProfileUI();
      initSiteToggle(siteSettings);

      // Prefill returning users' stored profile from backend
      fetchProfileFromBackend()
        .then((profile) => {
          // Only overwrite if backend has something meaningful
          if (profile && (profile.firstName || profile.lastName || profile.email || profile.phone)) {
            prefillFormFromServerProfile(profile);
          }
        })
        .catch(() => {});

      $("profileSelect").addEventListener("change", onProfileSelectChange);

      // Account settings: API key connect status
      $("saveApiKeyBtn")?.addEventListener("click", () => saveApiKeyFromInput());
      $("removeApiKeyBtn")?.addEventListener("click", () => removeApiKey());
      fetchApiKeyStatus();

      $("newProfileBtn").addEventListener("click", onNewProfile);

      $("saveProfileBtn").addEventListener("click", onSaveProfile);
      $("fillNowBtn").addEventListener("click", onFillNow);
      $("generateCoverBtn").addEventListener("click", onGenerateCoverLetter);

      $("parseResumeBtn").addEventListener("click", onParseResumeClick);
      $("markAppliedBtn").addEventListener("click", onMarkApplied);

      $("tabApplyBtn").addEventListener("click", onShowApplyTab);
      $("tabHistoryBtn").addEventListener("click", onShowHistoryTab);

      onShowApplyTab();
    });
  });
});




