// ── Gateway Connection ──
function setStatus(id, kind, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.kind = kind || '';
  el.textContent = message || '';
}

async function loadGateway() {
  const stored = await chrome.storage.local.get(['gatewayUrl', 'gatewayToken']);
  document.getElementById('gatewayUrl').value = stored.gatewayUrl || '';
  document.getElementById('token').value = stored.gatewayToken || '';
  if (stored.gatewayUrl) {
    setStatus('gatewayStatus', 'ok', `Will connect to: ${stored.gatewayUrl}`);
  }
}

async function saveGateway() {
  const gatewayUrl = String(document.getElementById('gatewayUrl').value || '').trim();
  const gatewayToken = String(document.getElementById('token').value || '').trim();
  // Store gatewayUrl in both keys for backward compat with sidepanel
  await chrome.storage.local.set({ gatewayUrl, gatewayWsUrl: gatewayUrl, gatewayToken });
  setStatus('gatewayStatus', 'ok', gatewayUrl ? `Saved! Will connect to: ${gatewayUrl}` : 'Saved. Using default (ws://127.0.0.1:18789)');
  // Notify background to re-read settings
  chrome.runtime.sendMessage({ type: 'settings-updated' });
}

document.getElementById('saveGateway')?.addEventListener('click', () => void saveGateway());



// ── New Tab Page ──
function updateNestedSections() {
  const ntpEnabled = document.getElementById('ntpEnabled').checked;
  const sub = document.getElementById('ntpSubSettings');
  if (sub) sub.style.display = ntpEnabled ? '' : 'none';
}

async function loadNtp() {
  const stored = await chrome.storage.local.get(['ntpEnabled']);
  // Default to true (enabled)
  document.getElementById('ntpEnabled').checked = stored.ntpEnabled !== false;
  updateNestedSections();
}

async function saveNtp() {
  const ntpEnabled = document.getElementById('ntpEnabled').checked;
  await chrome.storage.local.set({ ntpEnabled });
  setStatus('ntpStatus', 'ok', ntpEnabled ? 'Custom NTP enabled. Reload extension to apply.' : 'Custom NTP disabled. Reload extension to apply.');
  setTimeout(() => setStatus('ntpStatus', '', ''), 4000);
  // Notify background to re-read settings
  chrome.runtime.sendMessage({ type: 'settings-updated' });
  updateNestedSections();
}

document.getElementById('ntpEnabled')?.addEventListener('change', () => void saveNtp());

// ── Voice / STT ──
async function loadStt() {
  const stored = await chrome.storage.local.get(['sttUrl', 'sttApiKey', 'sttModel']);
  document.getElementById('sttUrl').value = String(stored.sttUrl || '').trim();
  document.getElementById('sttApiKey').value = String(stored.sttApiKey || '').trim();
  document.getElementById('sttModel').value = String(stored.sttModel || '').trim();
}

async function saveStt() {
  const sttUrl = String(document.getElementById('sttUrl').value || '').trim();
  const sttApiKey = String(document.getElementById('sttApiKey').value || '').trim();
  const sttModel = String(document.getElementById('sttModel').value || '').trim();
  await chrome.storage.local.set({ sttUrl, sttApiKey, sttModel });
  setStatus('sttStatus', 'ok', 'Saved!');
  setTimeout(() => setStatus('sttStatus', '', ''), 2000);
  // Notify background to re-read settings
  chrome.runtime.sendMessage({ type: 'settings-updated' });
}

document.getElementById('saveStt')?.addEventListener('click', () => void saveStt());

// ── Karakeep ──
async function loadKarakeep() {
  const stored = await chrome.storage.local.get(['karakeepUrl', 'karakeepApiKey']);
  document.getElementById('karakeepUrl').value = String(stored.karakeepUrl || '').trim();
  document.getElementById('karakeepApiKey').value = String(stored.karakeepApiKey || '').trim();
}

async function saveKarakeep() {
  const karakeepUrl = String(document.getElementById('karakeepUrl').value || '').trim().replace(/\/$/, '');
  const karakeepApiKey = String(document.getElementById('karakeepApiKey').value || '').trim();
  await chrome.storage.local.set({ karakeepUrl, karakeepApiKey });
  setStatus('karakeepStatus', 'ok', '✓ Saved');
  setTimeout(() => setStatus('karakeepStatus', '', ''), 2000);
  // Notify background to re-read settings
  chrome.runtime.sendMessage({ type: 'settings-updated' });
}

document.getElementById('saveKarakeep')?.addEventListener('click', () => void saveKarakeep());

// ── Homepage ──
async function loadHomepage() {
  const stored = await chrome.storage.local.get(['homepageUrl']);
  document.getElementById('homepageUrl').value = String(stored.homepageUrl || '').trim();
}

async function saveHomepage() {
  const homepageUrl = String(document.getElementById('homepageUrl').value || '').trim().replace(/\/$/, '');
  await chrome.storage.local.set({ homepageUrl });
  setStatus('homepageStatus', 'ok', '✓ Saved');
  setTimeout(() => setStatus('homepageStatus', '', ''), 2000);
  // Notify background to re-read settings
  chrome.runtime.sendMessage({ type: 'settings-updated' });
}

document.getElementById('saveHomepage')?.addEventListener('click', () => void saveHomepage());

// ── Load all ──
void loadGateway();
void loadNtp();
void loadStt();
void loadKarakeep();
void loadHomepage();
