chrome.runtime.onInstalled.addListener(() => {
  console.log("[otoppy Extension installed");

  // Optional: initialize defaults once.
  chrome.storage.sync.get(["jobProfiles", "activeProfileId", "siteSettings"], (data) => {
    const updates = {};

    if (!Array.isArray(data.jobProfiles)) updates.jobProfiles = [];
    if (typeof data.activeProfileId === "undefined") updates.activeProfileId = null;
    if (!data.siteSettings) updates.siteSettings = {};

    if (Object.keys(updates).length) {
      chrome.storage.sync.set(updates);
    }
  });
});

