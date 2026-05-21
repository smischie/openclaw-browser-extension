// Check if custom NTP is disabled — redirect to blank
chrome.storage.local.get(['ntpEnabled'], (result) => {
  if (result.ntpEnabled === false) {
    document.documentElement.innerHTML = '<head><title>New Tab</title></head><body style="background:#1a1a2e"></body>';
  }
});
