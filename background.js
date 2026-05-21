/**
 * OpenClaw Browser Extension — Background Service Worker
 * Handles: sidebar lifecycle, tab context tracking, context menus,
 * NTP bookmarks, offscreen audio, origin rewrite rules, tab manager.
 * NO CDP/debugger/relay code.
 */

const MAX_TABS_DEFAULT = 5;

// ── Tab context tracking (lightweight, no CDP) ──
// Tracks which tabs the user has selected for context sharing
/** @type {Map<number, {title:string, url:string, favIconUrl:string}>} */
const contextTabs = new Map();

function updateGlobalBadge() {
  const count = contextTabs.size;
  if (count > 0) {
    void chrome.action.setBadgeText({ text: String(count) });
    void chrome.action.setBadgeBackgroundColor({ color: '#FF5A36' });
    void chrome.action.setBadgeTextColor({ color: '#FFFFFF' }).catch(() => {});
  } else {
    void chrome.action.setBadgeText({ text: '' });
  }
}

// Persist context tabs to survive service worker restarts
async function persistState() {
  try {
    const entries = [];
    for (const [tabId, info] of contextTabs.entries()) {
      entries.push({ tabId, ...info });
    }
    await chrome.storage.session.set({ contextTabs: entries });
  } catch {}
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['contextTabs']);
    const entries = stored.contextTabs || [];
    for (const entry of entries) {
      // Verify tab still exists
      try {
        const tab = await chrome.tabs.get(entry.tabId);
        contextTabs.set(entry.tabId, { title: tab.title || entry.title, url: tab.url || entry.url, favIconUrl: tab.favIconUrl || entry.favIconUrl });
      } catch {
        // Tab gone
      }
    }
    updateGlobalBadge();
  } catch {}
}

async function addContextTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return { ok: false, error: 'Tab not found' };
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('chrome-extension://')) {
      return { ok: false, error: 'Cannot track browser/extension pages' };
    }
    const maxTabs = await getMaxTabs();
    if (contextTabs.size >= maxTabs && !contextTabs.has(tabId)) {
      return { ok: false, error: `Max ${maxTabs} tabs` };
    }
    contextTabs.set(tabId, { title: tab.title || '', url: tab.url || '', favIconUrl: tab.favIconUrl || '' });
    updateGlobalBadge();
    await persistState();
    return { ok: true, tabId: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function removeContextTab(tabId) {
  contextTabs.delete(tabId);
  updateGlobalBadge();
  void persistState();
}

async function getMaxTabs() {
  try {
    const stored = await chrome.storage.local.get(['maxTabs']);
    return Math.max(1, Math.min(20, parseInt(stored.maxTabs) || MAX_TABS_DEFAULT));
  } catch {
    return MAX_TABS_DEFAULT;
  }
}

// ── Tab lifecycle cleanup ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (contextTabs.has(tabId)) {
    contextTabs.delete(tabId);
    updateGlobalBadge();
    void persistState();
  }
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (contextTabs.has(removedTabId)) {
    const info = contextTabs.get(removedTabId);
    contextTabs.delete(removedTabId);
    contextTabs.set(addedTabId, info);
    updateGlobalBadge();
    void persistState();
  }
});

// Update tab info when title/URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tabInfo) => {
  if (!contextTabs.has(tabId)) return;
  if (changeInfo.title || changeInfo.url || changeInfo.favIconUrl) {
    const existing = contextTabs.get(tabId);
    contextTabs.set(tabId, {
      title: changeInfo.title || existing.title,
      url: changeInfo.url || existing.url,
      favIconUrl: changeInfo.favIconUrl || existing.favIconUrl,
    });
  }
});

// ── Offscreen audio recording management ──
let offscreenReady = false;
let offscreenPort = null;
let offscreenCallbacks = new Map();
let sidepanelPortForMic = null;

async function ensureOffscreen() {
  if (offscreenReady && offscreenPort) return;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts && contexts.length > 0) {
      if (!offscreenPort) {
        await new Promise(r => setTimeout(r, 200));
        if (offscreenPort) { offscreenReady = true; return; }
      } else {
        offscreenReady = true;
        return;
      }
    }
  } catch (_) {}
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'Audio recording for voice input'
  });
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (offscreenPort) { clearInterval(check); resolve(); }
    }, 50);
    setTimeout(() => { clearInterval(check); resolve(); }, 3000);
  });
  offscreenReady = true;
}

// ── Context menus ──
function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open-sidebar',
      title: 'Open Sidebar',
      contexts: ['page', 'frame'],
    });
    chrome.contextMenus.create({
      id: 'ask-openclaw',
      title: 'Ask OpenClaw',
      contexts: ['page', 'frame'],
    });
    chrome.contextMenus.create({
      id: 'send-to-openclaw',
      title: 'Send to OpenClaw',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'add-to-ntp',
      title: 'Add to NTP',
      contexts: ['page', 'frame', 'link'],
    });
    rebuildNtpCategoryMenus();
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
  installOriginRules();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

chrome.runtime.onStartup?.addListener(() => {
  installOriginRules();
});

// ── NTP Category Submenus ──
function rebuildNtpCategoryMenus() {
  chrome.storage.local.get('newtab_bookmarks', (result) => {
    const data = result.newtab_bookmarks;
    if (!data || !data.categories) return;

    const removePromises = data.categories.map(cat =>
      chrome.contextMenus.remove('ntp-cat-' + cat.id).catch(() => {})
    );
    chrome.contextMenus.remove('ntp-cat-new').catch(() => {});

    Promise.all(removePromises).then(() => {
      for (const cat of [...data.categories].sort((a, b) => a.order - b.order)) {
        chrome.contextMenus.create({
          id: 'ntp-cat-' + cat.id,
          parentId: 'add-to-ntp',
          title: cat.icon + ' ' + cat.name,
          contexts: ['page', 'frame', 'link'],
        });
      }
      chrome.contextMenus.create({
        id: 'ntp-cat-new',
        parentId: 'add-to-ntp',
        title: '\u2795 New Category...',
        contexts: ['page', 'frame', 'link'],
      });
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.newtab_bookmarks) {
    rebuildNtpCategoryMenus();
  }
});

// ── Context menu click handler ──
const ports = new Map();
let pendingContextSelection = null;

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'send-to-openclaw' && info.selectionText && tab?.id) {
    const port = ports.get('sidepanel-alive');
    if (port) {
      try {
        port.postMessage({
          type: 'CONTEXT_MENU_SELECTION',
          selectionText: info.selectionText,
          pageTitle: tab.title || 'Untitled',
          pageUrl: tab.url || '',
          tabId: tab.id
        });
      } catch (e) {
        console.warn('[OpenClaw] Failed to send context menu selection:', e);
      }
    } else {
      pendingContextSelection = {
        selectionText: info.selectionText,
        pageTitle: tab.title || 'Untitled',
        pageUrl: tab.url || '',
        tabId: tab.id
      };
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => { pendingContextSelection = null; });
    }
  } else if (info.menuItemId.startsWith('ntp-cat-') && tab) {
    const catId = info.menuItemId.replace('ntp-cat-', '');
    if (catId === 'new') {
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
      return;
    }
    const bookmark = {
      id: 'bm_' + crypto.randomUUID().slice(0, 8),
      title: tab.title || 'Untitled',
      url: info.linkUrl || tab.url || '',
      order: Date.now()
    };
    chrome.storage.local.get('newtab_bookmarks', (result) => {
      const data = result.newtab_bookmarks || { categories: [] };
      let targetCat = data.categories.find(c => c.id === catId);
      if (!targetCat) return;
      const url = bookmark.url;
      if (targetCat.bookmarks.some(b => b.url === url)) {
        chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#FF5A36', tabId: tab.id });
        setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 2000);
        return;
      }
      targetCat.bookmarks.push(bookmark);
      chrome.storage.local.set({ newtab_bookmarks: data }, () => {
        try {
          const json = JSON.stringify(data);
          if (json.length < 90000) chrome.storage.sync.set({ newtab_bookmarks: data });
        } catch {}
        chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId: tab.id });
        setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 2000);
      });
    });
  } else if (info.menuItemId === 'ask-openclaw' && tab?.id) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } else if (info.menuItemId === 'open-sidebar' && tab?.id) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// ── Side panel setup ──
if (chrome.sidePanel) {
  // Use explicit click handler — setPanelBehavior is unreliable on Edge
  chrome.action.onClicked.addListener(async (tab) => {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch(e) {
      // If open fails (already open?), try toggle via setOptions
      try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      } catch(e2) { console.warn('sidePanel open failed:', e2); }
    }
  });
}

// ── Sidebar port communication ──
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen-recorder') {
    offscreenPort = port;
    port.onMessage.addListener((msg) => {
      if (msg.type === 'OFFSCREEN_RESULT' || msg.type === 'OFFSCREEN_STREAM_RESULT') {
        const cb = offscreenCallbacks.get(msg.action);
        if (cb) {
          offscreenCallbacks.delete(msg.action);
          cb.resolve(msg);
        }
        return;
      }
      if (msg.type === 'OFFSCREEN_PARTIAL' || msg.type === 'OFFSCREEN_FINAL' || msg.type === 'OFFSCREEN_STREAM_ENDED') {
        try {
          sidepanelPortForMic?.postMessage({
            type: msg.type === 'OFFSCREEN_PARTIAL' ? 'PARTIAL_TRANSCRIPT'
              : msg.type === 'OFFSCREEN_FINAL' ? 'FINAL_TRANSCRIPT'
              : 'STREAM_ENDED',
            text: msg.text || ''
          });
        } catch (_) {}
      }
    });
    port.onDisconnect.addListener(() => {
      offscreenPort = null;
      offscreenReady = false;
      for (const [action, cb] of offscreenCallbacks.entries()) {
        cb.reject(new Error('Offscreen document disconnected'));
      }
      offscreenCallbacks.clear();
    });
    return;
  }

  if (port.name === 'sidepanel-alive') {
    ports.set('sidepanel-alive', port);
    sidepanelPortForMic = port;

    // Send pending context selection
    if (pendingContextSelection) {
      try {
        port.postMessage({ type: 'CONTEXT_MENU_SELECTION', ...pendingContextSelection });
      } catch {}
      pendingContextSelection = null;
    }

    port.onMessage.addListener((msg) => {
      const reply = (data) => { try { port.postMessage({ ...data, _id: msg._id }); } catch {} };

      if (msg.type === 'ATTACH_IF_NEEDED') {
        const tabId = msg.tabId;
        addContextTab(tabId).then(reply);
        return;
      }
      if (msg.type === 'DETACH_SPECIFIC_TAB') {
        removeContextTab(msg.tabId);
        reply({ ok: true });
        return;
      }
      if (msg.type === 'GET_ATTACHED_TABS') {
        // Return current context tabs, pruning stale ones
        const result = [];
        const stale = [];
        const promises = [];
        for (const [tabId] of contextTabs) {
          promises.push(
            chrome.tabs.get(tabId).then(tab => {
              result.push({ tabId: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl });
            }).catch(() => { stale.push(tabId); })
          );
        }
        Promise.all(promises).then(() => {
          for (const id of stale) contextTabs.delete(id);
          if (stale.length > 0) updateGlobalBadge();
          reply({ ok: true, tabs: result });
        });
        return;
      }
    });

    port.onDisconnect.addListener(() => {
      ports.delete('sidepanel-alive');
      if (sidepanelPortForMic === port) sidepanelPortForMic = null;
      // Sidebar closed — clear context tabs
      contextTabs.clear();
      updateGlobalBadge();
    });
  }
});

// ── Message handlers (legacy sendMessage-based + offscreen audio) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Open side panel from newtab
  if (msg?.type === 'OPEN_SIDE_PANEL' && sender.tab?.id) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    return;
  }

  // Bing search suggestions
  if (msg?.type === 'search-suggest') {
    const query = String(msg.query || '').trim();
    if (!query) { sendResponse({ suggestions: [] }); return true; }
    if (!globalThis._bingCvid) globalThis._bingCvid = crypto.randomUUID().replace(/-/g, '');
    const url = `https://www.bing.com/qbox?query=${encodeURIComponent(query)}&language=en-US&pt=EdgBox&cvid=${globalThis._bingCvid}&richanswersentity=1`;
    fetch(url, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data) || !Array.isArray(data[1])) {
          sendResponse({ queries: [], navigations: [] }); return;
        }
        const items = data[1];
        const meta = data[data.length - 1] || {};
        const types = meta['google:suggesttype'] || [];
        const scores = meta['google:suggestrelevance'] || [];
        const queries = [];
        const navigations = [];
        for (let i = 0; i < items.length; i++) {
          const entry = { text: items[i], score: scores[i] || 0 };
          const t = (types[i] || '').toUpperCase();
          if (t === 'NAVIGATION') navigations.push(entry);
          else queries.push(entry);
        }
        queries.sort((a, b) => b.score - a.score);
        navigations.sort((a, b) => b.score - a.score);
        sendResponse({
          queries: queries.slice(0, 4).map(e => e.text),
          navigations: navigations.slice(0, 3).map(e => e.text)
        });
      })
      .catch(() => sendResponse({ queries: [], navigations: [] }));
    return true;
  }

  if (msg?.type === 'karakeep-search') {
    const query = String(msg.query || '').trim();
    if (!query) { sendResponse({ results: [] }); return true; }
    chrome.storage.local.get(['karakeepUrl', 'karakeepApiKey']).then(stored => {
      const baseUrl = stored.karakeepUrl;
      const apiKey = stored.karakeepApiKey;
      if (!baseUrl || !apiKey) { sendResponse({ results: [] }); return; }
      fetch(`${baseUrl}/api/v1/bookmarks/search?q=${encodeURIComponent(query)}&limit=4`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3000)
      })
        .then(r => r.json())
        .then(data => {
          const results = (data.bookmarks || []).slice(0, 4).map(b => ({
            title: b.title || b.content?.title || '',
            url: b.content?.url || b.url || '',
          })).filter(b => b.url);
          sendResponse({ results });
        })
        .catch(() => sendResponse({ results: [] }));
    });
    return true;
  }

  if (msg?.type === 'MIC_PERMISSION_GRANTED') return;

  if (msg?.type === 'MIC_TRANSCRIBE') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get(['sttApiKey', 'sttModel', 'sttUrl', 'gatewayUrl']);
        let baseUrl;
        const customSttUrl = (stored.sttUrl || '').trim();
        if (customSttUrl) {
          baseUrl = customSttUrl;
        } else {
          baseUrl = (stored.gatewayUrl || 'ws://127.0.0.1:18789').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/v1/audio/transcriptions';
        }
        const sttUrl = customSttUrl || baseUrl;
        const model = stored.sttModel || 'deepdml/faster-whisper-large-v3-turbo-ct2';
        const apiKey = (stored.sttApiKey || '').trim();

        const audioResponse = await fetch(msg.data);
        const audioBlob = await audioResponse.blob();
        const fd = new FormData();
        fd.append('file', audioBlob, 'voice.webm');
        fd.append('model', model);

        const headers = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(sttUrl, { method: 'POST', headers, body: fd });
        if (!res.ok) throw new Error('Whisper ' + res.status);
        const data = await res.json();
        sendResponse({ ok: true, text: (data.text || '').trim() });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'MIC_START' || msg?.type === 'MIC_STOP') {
    const action = msg.type === 'MIC_START' ? 'start' : 'stop';
    const offscreenType = msg.type === 'MIC_START' ? 'OFFSCREEN_START' : 'OFFSCREEN_STOP';
    (async () => {
      try {
        await ensureOffscreen();
        if (!offscreenPort) throw new Error('Offscreen document not connected');
        const result = await new Promise((resolve, reject) => {
          offscreenCallbacks.set(action, { resolve, reject });
          offscreenPort.postMessage({ type: offscreenType });
          setTimeout(() => {
            if (offscreenCallbacks.has(action)) {
              offscreenCallbacks.delete(action);
              reject(new Error('Offscreen timeout'));
            }
          }, 10000);
        });
        if (!result.ok && result.error && (result.error.includes('NotAllowed') || result.error.includes('Permission'))) {
          await chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
          sendResponse({ ok: false, error: 'NEEDS_PERMISSION' });
        } else {
          sendResponse(result);
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'MIC_START_STREAM' || msg?.type === 'MIC_STOP_STREAM') {
    const action = msg.type === 'MIC_START_STREAM' ? 'start_stream' : 'stop_stream';
    const offscreenType = msg.type === 'MIC_START_STREAM' ? 'OFFSCREEN_START_STREAM' : 'OFFSCREEN_STOP_STREAM';
    (async () => {
      try {
        await ensureOffscreen();
        if (!offscreenPort) throw new Error('Offscreen document not connected');
        const result = await new Promise((resolve, reject) => {
          offscreenCallbacks.set(action, { resolve, reject });
          offscreenPort.postMessage({ type: offscreenType });
          setTimeout(() => {
            if (offscreenCallbacks.has(action)) {
              offscreenCallbacks.delete(action);
              reject(new Error('Offscreen timeout'));
            }
          }, 10000);
        });
        if (!result.ok && result.error && (result.error.includes('NotAllowed') || result.error.includes('Permission'))) {
          await chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
          sendResponse({ ok: false, error: 'NEEDS_PERMISSION' });
        } else {
          sendResponse(result);
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Tab manager: tabsQuery
  if (msg?.type === 'tabsQuery') {
    (async () => {
      try {
        const allTabs = await chrome.tabs.query({});
        let groupMap = new Map();
        try {
          if (chrome.tabGroups && chrome.tabGroups.query) {
            const groups = await chrome.tabGroups.query({});
            for (const g of groups) groupMap.set(g.id, g.title || '');
          }
        } catch {}
        const tabList = allTabs.map((t) => ({
          id: t.id, windowId: t.windowId,
          groupId: t.groupId ?? -1,
          groupName: groupMap.get(t.groupId) || '',
          title: t.title || '', url: t.url || '',
          pinned: !!t.pinned, active: !!t.active,
          status: t.status || '', index: t.index,
        }));
        sendResponse({ tabs: tabList });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'tabsClose') {
    (async () => {
      try {
        const tabIds = msg.tabIds || [];
        let closed = 0;
        const errors = [];
        try {
          await chrome.tabs.remove(tabIds);
          closed = tabIds.length;
        } catch {
          for (const id of tabIds) {
            try { await chrome.tabs.remove(id); closed++; } catch (e) {
              errors.push({ tabId: id, error: e.message });
            }
          }
        }
        for (const id of tabIds) {
          if (contextTabs.has(id)) contextTabs.delete(id);
        }
        updateGlobalBadge();
        sendResponse({ closed, errors });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'tabsDedupe') {
    (async () => {
      try {
        const allTabs = await chrome.tabs.query({});
        const byUrl = new Map();
        for (const t of allTabs) {
          const url = t.url || '';
          if (!url) continue;
          if (!byUrl.has(url)) byUrl.set(url, []);
          byUrl.get(url).push({ id: t.id, windowId: t.windowId, title: t.title || '' });
        }
        const duplicates = [];
        for (const [url, tabList] of byUrl.entries()) {
          if (tabList.length >= 2) duplicates.push({ url, count: tabList.length, tabs: tabList });
        }
        sendResponse({ duplicates });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // Set side panel title from gateway agent name
  if (msg?.type === 'set-panel-title' && msg.title) {
    chrome.sidePanel?.setTitle?.({ title: msg.title }).catch(() => {});
    chrome.action?.setTitle?.({ title: msg.title }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  // Settings updated notification from options page
  if (msg?.type === 'settings-updated') {
    // Re-read settings that affect background behavior
    (async () => {
      try {
        const stored = await chrome.storage.local.get([
          'gatewayUrl',
          'gatewayToken',
          'maxTabs',
          'sttUrl',
          'sttApiKey',
          'sttModel',
          'karakeepUrl',
          'karakeepApiKey',
          'homepageUrl'
        ]);
        
        // Update origin rules if gateway URL changed
        installOriginRules();
        
        // Note: Other settings (displayName, ntpEnabled) are read on-demand by their consumers,
        // so no action needed here. This handler exists primarily for future extensibility
        // and to trigger origin rule updates.
        
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});

// ── Favicon caching for NTP ──
chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0 || !url || url.startsWith('chrome')) return;
  try {
    const tabInfo = await chrome.tabs.get(tabId);
    if (!tabInfo.favIconUrl) return;
    const domain = new URL(url).hostname;
    chrome.storage.local.get('newtab_favicon_cache', (result) => {
      const cache = result.newtab_favicon_cache || {};
      if (cache[domain]) return;
      fetch(tabInfo.favIconUrl)
        .then(r => r.blob())
        .then(blob => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (reader.result && reader.result.length > 100) {
              cache[domain] = reader.result;
              chrome.storage.local.set({ newtab_favicon_cache: cache });
            }
          };
          reader.readAsDataURL(blob);
        })
        .catch(() => {});
    });
  } catch {}
});

// ── Dynamic Origin rewrite rules for sidepanel WebSocket ──
function installOriginRules() {
  // Read gateway URL from storage to create appropriate rules
  chrome.storage.local.get(['gatewayUrl'], (stored) => {
    const gatewayUrl = (stored.gatewayUrl || '').trim();
    const rules = [];

    // Always add localhost rule
    rules.push({
      id: 101, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'set', value: 'http://127.0.0.1:18789' }] },
      condition: { requestDomains: ['127.0.0.1'], resourceTypes: ['websocket'] }
    });

    // Add rule for configured gateway domain
    if (gatewayUrl) {
      try {
        const wsUrl = gatewayUrl.replace(/^ws/, 'http');
        const hostname = new URL(wsUrl).hostname;
        if (hostname && hostname !== '127.0.0.1' && hostname !== 'localhost') {
          const origin = wsUrl.startsWith('https') ? `https://${hostname}` : `http://${hostname}`;
          rules.push({
            id: 100, priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'set', value: origin }] },
            condition: { requestDomains: [hostname], resourceTypes: ['websocket'] }
          });
        }
      } catch {}
    }

    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [100, 101, 102, 103],
      addRules: rules,
    }).catch(e => console.error('[OpenClaw] Rule setup failed:', e));
  });
}

// Also install immediately
installOriginRules();

// ── Action click opens side panel ──

// ── Rehydrate on startup ──
rehydrateState();
