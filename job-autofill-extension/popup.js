// job-autofill-extension/popup.js

const PROFILE_FIELDS = [
  "profileName",
  "fullName",
  "email",
  "phone",
  "address",
  "location",
  "portfolio",
  "github",
  "linkedin",
  "whyRole",
  "aboutMe",
  "coverLetter"
];

let profiles = [];
let activeProfileId = null;
let currentDomain = null;

const BACKEND_URL = "http://localhost:4000";

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
      fullName: "",
      email: "",
      phone: "",
      address: "",
      location: "",
      portfolio: "",
      github: "",
      linkedin: "",
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
  const resp = await fetch(`${BACKEND_URL}/generate-cover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileData, jobContext })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Backend error: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  if (!data || typeof data.coverLetter !== "string") throw new Error("Invalid backend response");
  return data.coverLetter;
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
    .replace(/\"/g, """)
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

document.addEventListener("DOMContentLoaded", () => {
  loadProfilesFromStorage((siteSettings) => {
    refreshProfileUI();
    initSiteToggle(siteSettings);

    $("profileSelect").addEventListener("change", onProfileSelectChange);
    $("newProfileBtn").addEventListener("click", onNewProfile);
    $("saveProfileBtn").addEventListener("click", onSaveProfile);
    $("fillNowBtn").addEventListener("click", onFillNow);
    $("generateCoverBtn").addEventListener("click", onGenerateCoverLetter);

    $("markAppliedBtn").addEventListener("click", onMarkApplied);

    $("tabApplyBtn").addEventListener("click", onShowApplyTab);
    $("tabHistoryBtn").addEventListener("click", onShowHistoryTab);

    onShowApplyTab();
  });
});

