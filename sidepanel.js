import { loadOrCreateDeviceIdentity, signDevicePayload } from './device-identity.js';

const SESSION_KEY = 'agent:main:sidebar';
const MAX_TABS_DEFAULT = 5;
let maxTabs = MAX_TABS_DEFAULT;
let deviceIdentity = null;
let ws = null;
let connected = false;
let host = '127.0.0.1';
let gwPort = 18789;
let token = '';
let pendingResponses = new Map();
let reconnectTimer = null;
let waitingForReply = false;
let connectNonce = null;
let gatewayWsUrl = '';

// STT configuration
let sttUrl = '';
let sttApiKey = '';
let sttModel = '';

// Display name (configurable)
let displayName = 'OpenClaw';

// Multi-tab state: Map<tabId, { title, url, favIconUrl }>
const attachedTabs = new Map();

const msgEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const downloadBtn = document.getElementById('downloadBtn');
const micBtn = document.getElementById('micBtn');
const typingEl = document.getElementById('typing');
const statusDot = document.getElementById('statusDot'); // may be null
const emptyState = document.getElementById('emptyState');
const btnDashboard = document.getElementById('btnDashboard');
const btnSettings = document.getElementById('btnSettings');
const btnSnapshot = document.getElementById('btnSnapshot');
const followToggle = document.getElementById('followToggle');

const tabsPanel = document.getElementById('tabsPanel');
const tabStatsEl = document.getElementById('tabStatsText');

// ── Pin state: Set<tabId> ──
const pinnedTabs = new Set();

// ── File attachments: pending files to send with next message ──
// Each entry: { file: File, base64: string, mimeType: string, fileName: string, previewUrl?: string }
const pendingAttachments = [];
const MAX_ATTACHMENT_SIZE = 5_000_000; // 5 MB decoded
const MAX_ATTACHMENTS = 5;

// ── Copy helpers (message + code blocks) ──
function flashCopied(btn, originalLabel = null) {
  if (!btn) return;
  const prevText = originalLabel ?? btn.textContent;
  btn.classList.add('copied');
  if (btn.classList.contains('code-copy-btn')) btn.textContent = 'Copied!';
  setTimeout(() => {
    btn.classList.remove('copied');
    if (btn.classList.contains('code-copy-btn')) btn.textContent = prevText;
  }, 900);
}

msgEl.addEventListener('click', async (e) => {
  const actionBtn = e.target.closest('.msg-action-btn');
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    const row = actionBtn.closest('.msg-row');
    if (action === 'copy') {
      const text = row?.dataset?.copyText || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        actionBtn.classList.add('copied');
        const orig = actionBtn.innerHTML;
        actionBtn.innerHTML = '✓';
        setTimeout(() => { actionBtn.classList.remove('copied'); actionBtn.innerHTML = orig; }, 900);
      } catch (err) { console.warn('Copy failed:', err); }
    } else if (action === 'tts') {
      const text = row?.dataset?.copyText || '';
      if (!text) return;
      // Send /tts audio <text> to gateway
      inputEl.value = '/tts audio ' + text.slice(0, 500);
      sendMessage();
    }
    return;
  }

  const codeCopyBtn = e.target.closest('.code-copy-btn');
  if (codeCopyBtn) {
    const block = codeCopyBtn.closest('.code-block');
    const codeEl = block?.querySelector('pre code');
    const codeText = codeEl?.textContent || '';
    if (!codeText) return;
    try {
      await navigator.clipboard.writeText(codeText);
      flashCopied(codeCopyBtn, 'Copy');
    } catch (err) {
      console.warn('Copy failed:', err);
    }
  }
});

async function loadPinnedTabs() {
  try {
    const stored = await chrome.storage.local.get(['pinnedTabs']);
    if (Array.isArray(stored.pinnedTabs)) {
      stored.pinnedTabs.forEach(id => pinnedTabs.add(id));
    }
  } catch {}
}

async function savePinnedTabs() {
  await chrome.storage.local.set({ pinnedTabs: [...pinnedTabs] });
}

// ── Follow-tab mode ──
let followMode = false;

async function loadFollowMode() {
  const stored = await chrome.storage.local.get(['autoAttach']);
  followMode = !!stored.autoAttach;
  followToggle.checked = followMode;
}



followToggle.addEventListener('change', async () => {
  followMode = followToggle.checked;
  await chrome.storage.local.set({ autoAttach: followMode });
  if (followMode) {
    // Immediately attach current tab
    await followToActiveTab();
  } else {
    // Detach all unpinned tabs
    for (const tabId of [...attachedTabs.keys()]) {
      if (!pinnedTabs.has(tabId)) {
        await sendBg({ type: 'DETACH_SPECIFIC_TAB', tabId });
        attachedTabs.delete(tabId);
      }
    }
    renderTabs();
  }
});

async function followToActiveTab() {
  if (!followMode) return;
  const gen = ++followGeneration;
  try {
    const allTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (gen !== followGeneration) return; // superseded by newer call
    const activeTab = allTabs[0];
    
    // Check if the active tab is unattachable (chrome://, edge://, or chrome-extension://)
    const isUnattachable = activeTab?.url && (
      activeTab.url.startsWith('chrome://') || 
      activeTab.url.startsWith('edge://') || 
      activeTab.url.startsWith('chrome-extension://')
    );

    if (isUnattachable) {
      // Detach all unpinned tabs when switching to an unattachable page
      for (const tabId of [...attachedTabs.keys()]) {
        if (!pinnedTabs.has(tabId)) {
          await sendBg({ type: 'DETACH_SPECIFIC_TAB', tabId });
          if (gen !== followGeneration) return;
          attachedTabs.delete(tabId);
        }
      }
      renderTabs();
      return;
    }
    
    // At this point we have an attachable tab
    const tab = activeTab;
    if (!tab?.id) return;

    // Detach all unpinned tabs that aren't the target
    for (const tabId of [...attachedTabs.keys()]) {
      if (tabId !== tab.id && !pinnedTabs.has(tabId)) {
        await sendBg({ type: 'DETACH_SPECIFIC_TAB', tabId });
        if (gen !== followGeneration) return;
        attachedTabs.delete(tabId);
      }
    }

    // Attach the new active tab (if not already)
    if (!attachedTabs.has(tab.id)) {
      const result = await sendBg({ type: 'ATTACH_IF_NEEDED', tabId: tab.id });
      if (gen !== followGeneration) return;
      if (result?.ok !== false) {
        attachedTabs.set(tab.id, { title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl });
      }
    }
    renderTabs();
  } catch(e) {
    console.warn('Follow-tab failed:', e);
  }
}

// Listen for tab activation changes (debounced to handle rapid switching)
let followTimer = null;
let followGeneration = 0;
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!followMode) return;
  if (followTimer) clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    followTimer = null;
    followToActiveTab();
  }, 200);
});

loadFollowMode();
loadPinnedTabs();

// ── Live tab stats in header ──
async function updateTabStats() {
  try {
    const allTabs = await chrome.tabs.query({});
    const windowCount = new Set(allTabs.map(t => t.windowId)).size;
    const pinnedCount = allTabs.filter(t => t.pinned).length;
    let groupCount = 0;
    try {
      if (chrome.tabGroups && chrome.tabGroups.query) {
        const groups = await chrome.tabGroups.query({});
        groupCount = groups.length;
      }
    } catch(e) {}
    let text = `${allTabs.length} tabs`;
    if (pinnedCount > 0) text += ` · ${pinnedCount} pined`;
    if (groupCount > 0) text += ` · ${groupCount} grps`;
    if (windowCount > 1) text += ` · ${windowCount} windows`;
    if (tabStatsEl) tabStatsEl.textContent = text;
  } catch(e) {}
}
updateTabStats();
setInterval(updateTabStats, 5000);

function uuid() { return crypto.randomUUID(); }

// Auto-resize textarea
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

// ── Slash Command Picker ──
const SLASH_COMMANDS = [
  // SESSION
  { cmd: '/session', args: '[action] [value]', desc: 'Manage session-level settings', category: 'SESSION', icon: '⟳', argsMenu: ['idle', 'max-age'] },
  { cmd: '/focus', args: '[target]', desc: 'Bind thread to a session target', category: 'SESSION', icon: '⟳' },
  { cmd: '/unfocus', args: '', desc: 'Remove thread/topic binding', category: 'SESSION', icon: '⟳' },
  { cmd: '/stop', args: '', desc: 'Stop the current run', category: 'SESSION', icon: '⟳', instant: true },
  { cmd: '/reset', args: '', desc: 'Reset the current session', category: 'SESSION', icon: '⟳', instant: true },
  { cmd: '/new', args: '', desc: 'Start a new session', category: 'SESSION', icon: '⟳', instant: true },
  { cmd: '/compact', args: '[instructions]', desc: 'Compact the session context', category: 'SESSION', icon: '⟳' },
  { cmd: '/clear', args: '', desc: 'Clear chat history', category: 'SESSION', icon: '⟳', instant: true, local: true },
  // OPTIONS
  { cmd: '/usage', args: '[mode]', desc: 'Usage footer or cost summary', category: 'OPTIONS', icon: '⚙', argsMenu: ['off', 'tokens', 'full', 'cost'] },
  { cmd: '/think', args: '[level]', desc: 'Set thinking level', category: 'OPTIONS', icon: '⚙', aliases: ['/thinking', '/t'], argsMenu: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { cmd: '/verbose', args: '[mode]', desc: 'Toggle verbose mode', category: 'OPTIONS', icon: '⚙', aliases: ['/v'], argsMenu: ['on', 'off'] },
  { cmd: '/fast', args: '[mode]', desc: 'Toggle fast mode', category: 'OPTIONS', icon: '⚙', argsMenu: ['status', 'on', 'off'] },
  { cmd: '/reasoning', args: '[mode]', desc: 'Toggle reasoning visibility', category: 'OPTIONS', icon: '⚙', aliases: ['/reason'], argsMenu: ['on', 'off', 'stream'] },
  { cmd: '/elevated', args: '[mode]', desc: 'Toggle elevated mode', category: 'OPTIONS', icon: '⚙', aliases: ['/elev'], argsMenu: ['on', 'off', 'ask', 'full'] },
  { cmd: '/exec', args: '', desc: 'Set exec defaults for this session', category: 'OPTIONS', icon: '⚙' },
  { cmd: '/model', args: '[model]', desc: 'Show or set the model', category: 'OPTIONS', icon: '⚙' },
  { cmd: '/models', args: '', desc: 'List model providers', category: 'OPTIONS', icon: '⚙' },
  { cmd: '/queue', args: '', desc: 'Adjust queue settings', category: 'OPTIONS', icon: '⚙' },
  // STATUS
  { cmd: '/help', args: '', desc: 'Show available commands', category: 'STATUS', icon: '📊' },
  { cmd: '/commands', args: '', desc: 'List all slash commands', category: 'STATUS', icon: '📊' },
  { cmd: '/tools', args: '[mode]', desc: 'List available runtime tools', category: 'STATUS', icon: '📊' },
  { cmd: '/status', args: '', desc: 'Show current status', category: 'STATUS', icon: '📊' },
  { cmd: '/tasks', args: '', desc: 'List background tasks', category: 'STATUS', icon: '📊' },
  { cmd: '/context', args: '', desc: 'Explain how context is built', category: 'STATUS', icon: '📊' },
  { cmd: '/whoami', args: '', desc: 'Show your sender id', category: 'STATUS', icon: '📊', aliases: ['/id'] },
  { cmd: '/export-session', args: '[path]', desc: 'Export session to HTML', category: 'STATUS', icon: '📊', aliases: ['/export'] },
  // MANAGEMENT
  { cmd: '/allowlist', args: '', desc: 'List/add/remove allowlist entries', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/approve', args: '', desc: 'Approve or deny exec requests', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/subagents', args: '[action] [target] [value]', desc: 'Manage subagent runs', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/acp', args: '[action] [value]', desc: 'Manage ACP sessions', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/agents', args: '', desc: 'List thread-bound agents', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/kill', args: '[target]', desc: 'Kill a running subagent', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/steer', args: '[target] [message]', desc: 'Send guidance to a subagent', category: 'MANAGEMENT', icon: '🔧', aliases: ['/tell'] },
  { cmd: '/send', args: '[mode]', desc: 'Set send policy', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/activation', args: '[mode]', desc: 'Set group activation mode', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/config', args: '[action] [path] [value]', desc: 'Show or set config values', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/mcp', args: '[action] [path] [value]', desc: 'Show or set MCP servers', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/plugins', args: '[action] [path]', desc: 'List, show, enable/disable plugins', category: 'MANAGEMENT', icon: '🔧' },
  { cmd: '/debug', args: '[action] [path] [value]', desc: 'Set runtime debug overrides', category: 'MANAGEMENT', icon: '🔧' },
  // MEDIA
  { cmd: '/tts', args: '[action] [value]', desc: 'Control text-to-speech', category: 'MEDIA', icon: '🎵' },
  // TOOLS
  { cmd: '/skill', args: '[name] [input]', desc: 'Run a skill by name', category: 'TOOLS', icon: '🛠' },
  { cmd: '/btw', args: '', desc: 'Side question without changing context', category: 'TOOLS', icon: '🛠' },
  { cmd: '/restart', args: '', desc: 'Restart OpenClaw', category: 'TOOLS', icon: '🛠' },
  { cmd: '/bash', args: '[command]', desc: 'Run host shell commands', category: 'TOOLS', icon: '🛠' },
  // SIDEBAR-LOCAL
  { cmd: '/tabs', args: '', desc: 'Tab manager commands', category: 'TABS', icon: '🗂', local: true },
];

const CATEGORY_ORDER = ['SESSION', 'OPTIONS', 'STATUS', 'MANAGEMENT', 'MEDIA', 'TOOLS', 'TABS'];

let cmdPickerEl = null;
let cmdPickerVisible = false;
let cmdFilteredItems = [];
let cmdSelectedIndex = 0;

function createCmdPicker() {
  if (cmdPickerEl) return cmdPickerEl;
  cmdPickerEl = document.createElement('div');
  cmdPickerEl.className = 'cmd-picker';
  cmdPickerEl.addEventListener('mousedown', (e) => {
    // Prevent blur on textarea when clicking picker
    e.preventDefault();
  });
  const inputArea = document.querySelector('.input-area');
  inputArea.appendChild(cmdPickerEl);
  return cmdPickerEl;
}

function showCmdPicker(filter = '') {
  const picker = createCmdPicker();
  const query = filter.toLowerCase();

  // Filter commands
  cmdFilteredItems = SLASH_COMMANDS.filter(c => {
    const matchCmd = c.cmd.toLowerCase().includes(query);
    const matchAlias = c.aliases?.some(a => a.toLowerCase().includes(query)) || false;
    return matchCmd || matchAlias;
  });

  if (cmdFilteredItems.length === 0) {
    picker.innerHTML = '<div class="cmd-picker-empty">No commands match</div>';
    picker.classList.add('visible');
    cmdPickerVisible = true;
    cmdSelectedIndex = -1;
    return;
  }

  cmdSelectedIndex = 0;
  renderCmdPicker();
  picker.classList.add('visible');
  cmdPickerVisible = true;
}

function renderCmdPicker() {
  const picker = createCmdPicker();
  picker.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'cmd-picker-header';
  header.textContent = 'Commands';
  picker.appendChild(header);

  // Group by category
  let idx = 0;
  const grouped = new Map();
  for (const item of cmdFilteredItems) {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category).push({ ...item, _idx: idx++ });
  }

  for (const cat of CATEGORY_ORDER) {
    const items = grouped.get(cat);
    if (!items || items.length === 0) continue;

    const catLabel = document.createElement('div');
    catLabel.className = 'cmd-category-label';
    catLabel.textContent = cat;
    picker.appendChild(catLabel);

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'cmd-item' + (item._idx === cmdSelectedIndex ? ' selected' : '');
      row.dataset.idx = item._idx;

      const icon = document.createElement('span');
      icon.className = 'cmd-icon';
      icon.textContent = item.icon;
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'cmd-name';
      name.textContent = item.cmd;
      row.appendChild(name);

      if (item.args) {
        const args = document.createElement('span');
        args.className = 'cmd-args';
        args.textContent = ' ' + item.args;
        row.appendChild(args);
      }

      const desc = document.createElement('span');
      desc.className = 'cmd-desc';
      desc.textContent = item.desc;
      row.appendChild(desc);

      if (item.instant) {
        const badge = document.createElement('span');
        badge.className = 'cmd-badge instant';
        badge.textContent = 'instant';
        row.appendChild(badge);
      } else if (item.argsMenu) {
        const badge = document.createElement('span');
        badge.className = 'cmd-badge options';
        badge.textContent = item.argsMenu.length + ' options';
        row.appendChild(badge);
      }

      row.addEventListener('click', () => selectCmdItem(item._idx));
      row.addEventListener('mouseenter', () => {
        cmdSelectedIndex = item._idx;
        updateCmdSelection();
      });
      picker.appendChild(row);
    }
  }

  scrollCmdIntoView();
}

function updateCmdSelection() {
  if (!cmdPickerEl) return;
  const items = cmdPickerEl.querySelectorAll('.cmd-item');
  items.forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.idx) === cmdSelectedIndex);
  });
}

function scrollCmdIntoView() {
  if (!cmdPickerEl) return;
  const selected = cmdPickerEl.querySelector('.cmd-item.selected');
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function selectCmdItem(idx) {
  const item = cmdFilteredItems[idx];
  if (!item) return;
  hideCmdPicker();

  const hasArgs = !!item.args;

  if (item.local && item.cmd === '/clear') {
    // Local clear: clear chat messages
    msgEl.innerHTML = '';
    emptyState.style.display = '';
    emptyState.innerHTML = '<div class="emoji">💬</div><p>Chat cleared!</p>';
    inputEl.value = '';
    inputEl.style.height = 'auto';
    return;
  }

  if (item.local && item.cmd === '/tabs') {
    // Route to existing /tabs handler
    inputEl.value = '/tabs ';
    inputEl.style.height = 'auto';
    inputEl.focus();
    return;
  }

  if (item.instant && !hasArgs) {
    // Instant: send immediately
    inputEl.value = item.cmd;
    sendMessage();
    return;
  }

  if (!hasArgs) {
    // No args: send immediately
    inputEl.value = item.cmd;
    sendMessage();
    return;
  }

  // Has args: insert and let user type
  inputEl.value = item.cmd + ' ';
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  inputEl.focus();
  // Place cursor at end
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function hideCmdPicker() {
  if (cmdPickerEl) {
    cmdPickerEl.classList.remove('visible');
  }
  cmdPickerVisible = false;
  cmdFilteredItems = [];
  cmdSelectedIndex = 0;
}

// Hook into textarea input for slash detection
inputEl.addEventListener('input', () => {
  const val = inputEl.value;
  if (val.startsWith('/')) {
    const filter = val.slice(1).split(/\s/)[0] || '';
    // Only show picker if we're still typing the command (no space yet after the command word)
    // But if the entire value is just the slash + command prefix, show the picker
    const hasSpace = val.includes(' ') && val.indexOf(' ') > 0;
    if (!hasSpace) {
      showCmdPicker('/' + filter);
    } else {
      hideCmdPicker();
    }
  } else {
    hideCmdPicker();
  }
});

inputEl.addEventListener('keydown', (e) => {
  if (cmdPickerVisible) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdFilteredItems.length > 0) {
        cmdSelectedIndex = (cmdSelectedIndex + 1) % cmdFilteredItems.length;
        updateCmdSelection();
        scrollCmdIntoView();
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdFilteredItems.length > 0) {
        cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdFilteredItems.length) % cmdFilteredItems.length;
        updateCmdSelection();
        scrollCmdIntoView();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (cmdSelectedIndex >= 0 && cmdSelectedIndex < cmdFilteredItems.length) {
        selectCmdItem(cmdSelectedIndex);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideCmdPicker();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (cmdSelectedIndex >= 0 && cmdSelectedIndex < cmdFilteredItems.length) {
        selectCmdItem(cmdSelectedIndex);
      }
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    // Let emoji inline picker handle Enter when it's visible
    if (emojiInlineVisible) return;
    e.preventDefault();
    if (isRecording) {
      // Recording + Enter → stop recording (text lands in textarea for review)
      stopRecording();
    } else if (inputEl.value.trim() === '') {
      // Empty textarea + Enter → start voice recording
      startRecording();
    } else {
      // Text in textarea + Enter → send message
      sendMessage();
    }
  }
});

// Dismiss picker when clicking outside
document.addEventListener('click', (e) => {
  if (cmdPickerVisible && !cmdPickerEl?.contains(e.target) && e.target !== inputEl) {
    hideCmdPicker();
  }
});

// ── Paste image from clipboard ──
inputEl.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) continue;
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      addSystemMsg(`Max ${MAX_ATTACHMENTS} attachments at once`);
      break;
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      addSystemMsg('Pasted image too large (max 5 MB)');
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      pendingAttachments.push({
        file,
        base64,
        mimeType: file.type,
        fileName: file.name || `pasted-image.${file.type.split('/')[1] || 'png'}`,
        previewUrl: URL.createObjectURL(file),
      });
      renderAttachmentPreview();
    } catch (err) {
      addSystemMsg('Failed to read pasted image: ' + err.message);
    }
  }
});
sendBtn.addEventListener('click', sendMessage);
attachBtn?.addEventListener('click', () => {
  if (attachBtn.disabled) return;
  fileInput?.click();
});

// ── File attachment handling ──
fileInput?.addEventListener('change', async () => {
  const files = fileInput.files;
  if (!files || files.length === 0) return;
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      addSystemMsg(`Max ${MAX_ATTACHMENTS} attachments at once`);
      break;
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      addSystemMsg(`${file.name} too large (max 5 MB)`);
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      const entry = {
        file,
        base64,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      };
      pendingAttachments.push(entry);
    } catch (e) {
      addSystemMsg(`Failed to read ${file.name}: ${e.message}`);
    }
  }
  fileInput.value = ''; // reset so same file can be re-selected
  renderAttachmentPreview();
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

function renderAttachmentPreview() {
  let strip = document.getElementById('attachmentPreview');
  if (pendingAttachments.length === 0) {
    if (strip) strip.remove();
    return;
  }
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'attachmentPreview';
    strip.className = 'attachment-preview';
    // Insert before input-area
    const inputArea = document.querySelector('.input-area');
    inputArea.parentNode.insertBefore(strip, inputArea);
  }
  strip.innerHTML = '';
  pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    if (att.previewUrl) {
      const img = document.createElement('img');
      img.src = att.previewUrl;
      img.className = 'attachment-thumb';
      chip.appendChild(img);
    } else {
      const icon = document.createElement('span');
      icon.className = 'attachment-icon';
      icon.textContent = '📎';
      chip.appendChild(icon);
    }
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = att.fileName;
    name.title = att.fileName;
    chip.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      pendingAttachments.splice(idx, 1);
      renderAttachmentPreview();
    });
    chip.appendChild(removeBtn);
    strip.appendChild(chip);
  });
}
downloadBtn?.addEventListener('click', () => {
  const msgs = msgEl.querySelectorAll('.msg-row');
  const lines = [];
  // Messages are newest-first, reverse for chronological order
  const arr = Array.from(msgs).reverse();
  for (const row of arr) {
    const msg = row.querySelector('.msg');
    if (!msg) continue;
    const isUser = row.classList.contains('user');
    const ts = row.querySelector('.msg-group-timestamp');
    const timeStr = ts ? ts.textContent.trim() : '';
    // Get text from the bubble, excluding any nested UI elements
    const clone = msg.cloneNode(true);
    const text = clone.textContent.trim();
    if (!text) continue;
    const prefix = isUser ? 'You' : displayName;
    lines.push(`[${timeStr}] ${prefix}: ${text}`);
  }
  if (!lines.length) return;
  const blob = new Blob([lines.join('\n\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `openclaw-chat-${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});
btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
btnSnapshot?.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { addSystemMsg('No active tab found'); return; }
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('chrome-extension://')) {
      addSystemMsg('Cannot snapshot browser/extension pages'); return;
    }
    await snapshotTab(tab.id, { title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl });
  } catch(e) {
    addSystemMsg('Snapshot failed: ' + e.message);
  }
});
btnDashboard.addEventListener('click', () => {
  const gwUrl = gatewayWsUrl || `ws://${host}:${gwPort}`;
  const httpUrl = gwUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/';
  window.open(httpUrl, '_blank');
});

// ── Multi-Tab ──
function renderTabs() {
  tabsPanel.innerHTML = '';
  for (const [tabId, info] of attachedTabs) {
    const row = document.createElement('div');
    row.className = 'tab-row';
    const isPinned = pinnedTabs.has(tabId);

    // Eye indicator
    const eye = document.createElement('span');
    eye.className = 'tab-eye watching';
    eye.textContent = '👀';
    row.appendChild(eye);

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = info.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect fill="%23334" width="16" height="16" rx="3"/></svg>';
    favicon.onerror = () => { favicon.style.display = 'none'; };
    row.appendChild(favicon);

    const title = document.createElement('span');
    title.className = 'tab-title';

    const titleText = document.createElement('span');
    titleText.className = 'tab-title-text';
    titleText.textContent = info.title || 'Untitled';
    title.appendChild(titleText);

    const sep = document.createElement('span');
    sep.className = 'tab-title-sep';
    sep.textContent = '|';
    title.appendChild(sep);

    const urlText = document.createElement('span');
    urlText.className = 'tab-title-url';
    urlText.textContent = info.url || '';
    urlText.title = info.url || '';
    title.appendChild(urlText);

    row.appendChild(title);

    const actions = document.createElement('span');
    actions.className = 'tab-actions';

    const snapBtn = document.createElement('button');
    snapBtn.className = 'tab-btn';
    snapBtn.textContent = '📸';
    snapBtn.title = 'Share snapshot of this tab';
    snapBtn.addEventListener('click', () => snapshotTab(tabId, info));
    actions.appendChild(snapBtn);

    row.appendChild(actions);
    tabsPanel.appendChild(row);
  }
}

async function togglePin(tabId) {
  if (pinnedTabs.has(tabId)) {
    pinnedTabs.delete(tabId);
  } else {
    pinnedTabs.add(tabId);
  }
  await savePinnedTabs();
  renderTabs();
}

async function attachCurrentTab() {
  if (attachedTabs.size >= maxTabs) {
    // In follow mode, detach oldest unpinned to make room
    if (followMode) {
      for (const tabId of attachedTabs.keys()) {
        if (!pinnedTabs.has(tabId)) {
          await sendBg({ type: 'DETACH_SPECIFIC_TAB', tabId });
          attachedTabs.delete(tabId);
          break;
        }
      }
    }
    if (attachedTabs.size >= maxTabs) {
      addSystemMsg(`Max ${maxTabs} tabs — unpin one first`);
      return;
    }
  }
  try {
    const allTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = allTabs.find(t => !t.url?.startsWith('chrome-extension://'));
    if (!tab?.id) { addSystemMsg('No active tab found'); return; }
    if (attachedTabs.has(tab.id)) { addSystemMsg('Tab already attached: ' + tab.title); return; }
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://'))) {
      addSystemMsg('Cannot attach to browser/extension pages');
      return;
    }
    // Send and wait for response to report errors
    const result = await sendBg({ type: 'ATTACH_IF_NEEDED', tabId: tab.id });
    if (result?.ok === false) {
      addSystemMsg('Attach failed: ' + (result.error || 'unknown error'));
      attachedTabs.delete(tab.id);
      renderTabs();
      return;
    }
    // Optimistically add to local state; syncTabs will correct if needed
    attachedTabs.set(tab.id, { title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl });
    renderTabs();
    addSystemMsg('Attaching: ' + (tab.title || 'Tab'));
  } catch(e) {
    addSystemMsg('Attach failed: ' + (e.message || e));
  }
}

async function detachTab(tabId) {
  const info = attachedTabs.get(tabId);
  await sendBg({ type: 'DETACH_SPECIFIC_TAB', tabId });
  attachedTabs.delete(tabId);
  pinnedTabs.delete(tabId);
  await savePinnedTabs();
  renderTabs();
  addSystemMsg('Detached: ' + (info?.title || 'Tab'));
}

async function detachAllTabs() {
  for (const tabId of attachedTabs.keys()) {
    await sendBg({ type: 'DETACH_SPECIFIC_TAB', tabId });
  }
  attachedTabs.clear();
  renderTabs();
}

async function snapshotTab(tabId, info) {
  if (!connected) return;
  addMsg('user', '📸 ' + (info.title || 'Tab'));
  showTyping();
  waitingForReply = true;
  try {
    // Capture screenshot
    let screenshot = '';
    try {
      screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 75 });
    } catch(e) {
      console.warn('Screenshot failed:', e);
    }

    // Try to grab page text via scripting API
    let pageText = '';
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const sel = document.body.innerText || document.body.textContent || '';
          return sel.slice(0, 50000);
        }
      });
      pageText = results?.[0]?.result || '';
    } catch(e) {
      pageText = '(Could not extract page content: ' + e.message + ')';
    }

    const msg = [
      `The user shared a browser tab with you.`,
      `**Title:** ${info.title}`,
      `**URL:** ${info.url}`,
      ``,
      `**Page content (truncated):**`,
      '```',
      pageText || '(empty)',
      '```'
    ].join('\n');

    const params = {
      sessionKey: SESSION_KEY,
      message: msg,
      deliver: false,
      idempotencyKey: uuid(),
    };
    // Attach screenshot as image if captured
    if (screenshot) {
      const base64 = screenshot.replace(/^data:image\/jpeg;base64,/, '');
      params.attachments = [{
        mimeType: 'image/jpeg',
        fileName: 'screenshot.jpg',
        content: base64,
      }];
    }

    await sendReq('chat.send', params);
  } catch(e) {
    addSystemMsg('Snapshot failed: ' + e.message);
    hideTyping();
    waitingForReply = false;
  }
}

// ── Context Menu Selection Handler ──
let pendingContextMsg = null

async function handleContextMenuSelection(msg) {
  const { selectionText, pageTitle, pageUrl, tabId } = msg
  
  // If not connected to gateway yet, queue and retry after connection
  if (!connected) {
    // console.log('[OpenClaw] Context menu selection queued — waiting for gateway connection')
    pendingContextMsg = msg
    return
  }

  // Format the message to send
  const contextMessage = `[Selected from ${pageTitle}]:
> ${selectionText}

What is this?`
  
  // Auto-send the message (prefer speed over editing)
  try {
    showTyping()
    waitingForReply = true
    
    await sendReq('chat.send', {
      sessionKey: SESSION_KEY,
      message: contextMessage,
      deliver: true,
      idempotencyKey: uuid()
    })
    
    // Show the message in UI
    emptyState.style.display = 'none'
    addMsg('user', contextMessage)
    
    // Open side panel if not already open (this is called when sidebar receives the message, so it's already open)
    // But make sure it's visible/focused
    try {
      await chrome.sidePanel.open({ tabId })
    } catch (e) {
      // Side panel might already be open
    }
  } catch (e) {
    console.warn('[OpenClaw] Failed to send context menu selection:', e)
    hideTyping()
    waitingForReply = false
    addSystemMsg('Failed to send selection: ' + e.message)
  }
}

// ── Tab Sync ──
async function syncTabs() {
  try {
    const resp = await sendBg({ type: 'GET_ATTACHED_TABS' });
    if (!resp?.ok) return;
    attachedTabs.clear();
    for (const t of (resp.tabs || [])) {
      attachedTabs.set(t.tabId, { title: t.title, url: t.url, favIconUrl: t.favIconUrl });
    }
    renderTabs();
    // Persist attached tab IDs for session restore
    const stored = await chrome.storage.local.get(['rememberTabs']);
    if (stored.rememberTabs !== false) {
      const tabIds = [...attachedTabs.keys()];
      if (tabIds.length > 0) {
        await chrome.storage.local.set({ lastAttachedTabs: tabIds });
      }
    }
  } catch(e) {}
}

// btnAddTab removed — follow mode + pin handles attach/detach

// ── Session restore & auto-attach ──
async function restoreOrAutoAttach() {
  // When follow mode is on, skip session restore — doConnect() will
  // call followToActiveTab() which properly attaches the current active
  // tab and detaches stale ones.
  if (followMode) return;

  const stored = await chrome.storage.local.get(['rememberTabs', 'autoAttach', 'lastAttachedTabs']);

  // Try to restore previous session tabs
  if (stored.rememberTabs !== false && Array.isArray(stored.lastAttachedTabs) && stored.lastAttachedTabs.length > 0) {
    const tabIds = stored.lastAttachedTabs;
    // Verify tabs still exist
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    const allTabIds = new Set(allTabs.map(t => t.id));
    let restored = 0;
    for (const tabId of tabIds) {
      if (!allTabIds.has(tabId)) continue;
      if (attachedTabs.has(tabId)) continue;
      const tab = allTabs.find(t => t.id === tabId);
      if (tab?.url?.startsWith('chrome://') || tab?.url?.startsWith('edge://') || tab?.url?.startsWith('chrome-extension://')) continue;
      if (attachedTabs.size >= maxTabs) break;
      try {
        const result = await sendBg({ type: 'ATTACH_IF_NEEDED', tabId });
        if (result?.ok !== false) {
          attachedTabs.set(tabId, { title: tab?.title || '', url: tab?.url || '', favIconUrl: tab?.favIconUrl || '' });
          restored++;
        }
      } catch {}
    }
    if (restored > 0) {
      renderTabs();
      addSystemMsg(`Restored ${restored} tab${restored > 1 ? 's' : ''} from last session`);
      return;
    }
  }

  // Auto-attach current tab if follow mode is enabled and nothing restored
  if (followMode && attachedTabs.size === 0) {
    await followToActiveTab();
  } else if (stored.autoAttach && attachedTabs.size === 0) {
    await attachCurrentTab();
  }
}

// Sync on sidebar open
syncTabs();
// Poll every 2s to stay in sync with toolbar attach/detach
setInterval(syncTabs, 2000);

// Detach all on sidebar close (tab IDs already persisted by syncTabs)
window.addEventListener('beforeunload', () => { detachAllTabs(); });

// Kick off restore/auto-attach after initial sync
loadFollowMode().then(() => syncTabs().then(() => restoreOrAutoAttach()));

// ── Settings ──
async function loadSettings() {
  const stored = await chrome.storage.local.get(['gatewayToken', 'gatewayWsUrl', 'gatewayUrl', 'maxTabs', 'sttUrl', 'sttApiKey', 'sttModel']);
  // displayName is now hardcoded to 'OpenClaw' (removed from settings)
  token = stored.gatewayToken || '';
  gatewayWsUrl = (stored.gatewayWsUrl || stored.gatewayUrl || '').trim();
  // Derive host/port from gatewayWsUrl for backward compat
  if (gatewayWsUrl) {
    try {
      const u = new URL(gatewayWsUrl.replace(/^ws/, 'http'));
      host = u.hostname || '127.0.0.1';
      gwPort = parseInt(u.port) || 18789;
    } catch { host = '127.0.0.1'; gwPort = 18789; }
  } else { host = '127.0.0.1'; gwPort = 18789; }
  maxTabs = Math.max(1, Math.min(20, parseInt(stored.maxTabs) || MAX_TABS_DEFAULT));
  sttUrl = (stored.sttUrl || '').trim();
  sttApiKey = (stored.sttApiKey || '').trim();
  sttModel = (stored.sttModel || '').trim();
}

// ── WebSocket ──
function sendReq(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('Not connected')); return; }
    const id = uuid();
    pendingResponses.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => {
      if (pendingResponses.has(id)) { pendingResponses.delete(id); reject(new Error('Request timeout')); }
    }, 120000);
  });
}

async function doConnect() {
  // console.log('[OpenClaw] doConnect called, nonce:', connectNonce);
  try {
    const clientId = 'webchat';
    const clientMode = 'webchat';
    const extVersion = chrome.runtime.getManifest().version;
    const role = 'operator';
    const scopes = ['operator.admin'];

    if (!deviceIdentity) deviceIdentity = await loadOrCreateDeviceIdentity();

    if (!connectNonce) {
      console.warn('[OpenClaw] doConnect called without nonce — waiting for challenge');
      return;
    }

    const signedAtMs = Date.now();
    const sigPayload = ['v2', deviceIdentity.deviceId, clientId, clientMode, role, scopes.join(','), String(signedAtMs), token || '', connectNonce].join('|');
    const signature = await signDevicePayload(deviceIdentity.privateKey, sigPayload);

    const connectParams = {
      minProtocol: 3, maxProtocol: 3,
      auth: token ? { token } : undefined,
      role, scopes,
      client: { id: clientId, displayName: displayName || 'OpenClaw', version: extVersion, mode: clientMode, platform: navigator.platform || 'browser' },
      device: { id: deviceIdentity.deviceId, publicKey: deviceIdentity.publicKey, signature, signedAt: signedAtMs, nonce: connectNonce },
      caps: [], userAgent: navigator.userAgent, locale: navigator.language
    };
    // console.log('[OpenClaw] Sending signed connect with device identity...');
    const connectResult = await sendReq('connect', connectParams);
    // console.log('[OpenClaw] Connect result:', JSON.stringify(connectResult));
    // Fetch agent identity from gateway HTTP endpoint
    try {
      const httpUrl = gatewayWsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
      const configResp = await fetch(`${httpUrl}/__openclaw/control-ui-config.json`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (configResp.ok) {
        const configData = await configResp.json();
        if (configData.assistantName) {
          displayName = configData.assistantName;
          // Set side panel title via background (sidePanel API only works there)
          chrome.runtime.sendMessage({ type: 'set-panel-title', title: displayName }).catch(() => {});
        }
        if (configData.assistantAvatar) {
          try {
            const avatarResp = await fetch(`${httpUrl}${configData.assistantAvatar}`, {
              headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            if (avatarResp.ok) {
              const blob = await avatarResp.blob();
              const avatarUrl = URL.createObjectURL(blob);
              const avatar = document.getElementById('headerAvatar');
              if (avatar) avatar.src = avatarUrl;
            }
          } catch(e) { /* avatar fetch failed, keep default */ }
        }
        // console.log('[OpenClaw] Agent identity:', configData.assistantName, configData.assistantAvatar);
      }
    } catch(e) {
      console.warn('[OpenClaw] Failed to fetch agent identity:', e);
    }
    connected = true;
    setStatus('connected');
    inputEl.disabled = false;
    sendBtn.disabled = false;
    if (attachBtn) attachBtn.disabled = false;
    if (fileInput) fileInput.disabled = false;
    inputEl.focus();

    // Flush any pending context menu selection that arrived before WS connected
    if (pendingContextMsg) {
      const msg = pendingContextMsg
      pendingContextMsg = null
      handleContextMenuSelection(msg)
    }
    loadHistory();

    // ── Recover attached tabs after (re)connect ──
    // When follow mode is on, just follow to current active tab
    // (it detaches stale unpinned tabs automatically).
    // When follow mode is off, sync from background + attach current if empty.
    try {
      if (followMode) {
        await followToActiveTab();
      } else {
        const bgTabs = await sendBg({ type: 'GET_ATTACHED_TABS' });
        if (bgTabs?.ok && bgTabs.tabs) {
          attachedTabs.clear();
          for (const t of bgTabs.tabs) {
            attachedTabs.set(t.tabId, { title: t.title, url: t.url, favIconUrl: t.favIconUrl });
          }
        }
        if (attachedTabs.size === 0) {
          const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tab = activeTabs.find(t => t.id && !t.url?.startsWith('chrome-extension://') && !t.url?.startsWith('chrome://') && !t.url?.startsWith('edge://'));
          if (tab?.id) {
            const result = await sendBg({ type: 'ATTACH_IF_NEEDED', tabId: tab.id });
            if (result?.ok !== false) {
              attachedTabs.set(tab.id, { title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl });
            }
          }
        }
      }
      renderTabs();
    } catch(e) {
      console.warn('[OpenClaw] Tab recovery on connect failed:', e);
    }

    // ── Passive tab count report on connect ──
    try {
      const allTabs = await chrome.tabs.query({});
      const windowCount = new Set(allTabs.map(t => t.windowId)).size;
      const pinnedCount = allTabs.filter(t => t.pinned).length;
      const ungroupedCount = allTabs.filter(t => t.groupId === -1 || t.groupId === undefined).length;
      let groupInfo = '';
      let groupDetails = '';
      try {
        if (chrome.tabGroups && chrome.tabGroups.query) {
          const groups = await chrome.tabGroups.query({});
          if (groups.length > 0) {
            // Count tabs per group
            const groupTabCounts = {};
            groups.forEach(g => { groupTabCounts[g.id] = 0; });
            allTabs.forEach(t => {
              if (t.groupId !== -1 && groupTabCounts[t.groupId] !== undefined) {
                groupTabCounts[t.groupId]++;
              }
            });
            groupInfo = `, ${groups.length} group${groups.length !== 1 ? 's' : ''}`;
            const groupList = groups.map(g => `${g.title || 'Untitled'} (${g.color}, ${groupTabCounts[g.id]} tabs)`).join(', ');
            groupDetails = `\nGroups: ${groupList}`;
            groupDetails += `\nUngrouped: ${ungroupedCount} tabs`;
          }
        }
      } catch(e) { /* tabGroups not available */ }
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: `[Tab Count] ${allTabs.length} tabs open (${pinnedCount} pinned${groupInfo}) across ${windowCount} window${windowCount !== 1 ? 's' : ''}${groupDetails}`,
        deliver: false,
        idempotencyKey: uuid()
      });
    } catch(e) {
      console.warn('Tab count report failed:', e);
    }
  } catch(e) {
    console.warn('Connect handshake failed:', e.message);
    // Don't show transient handshake errors (e.g. challenge-response flow) to user
    if (connected) addSystemMsg('Connection failed: ' + e.message);
    ws.close();
  }
}

async function connectWs() {
  if (ws) { ws.close(); ws = null; }
  setStatus('connecting');
  connectNonce = null;

  try { await loadSettings(); } catch(e) {}

  let url;
  if (gatewayWsUrl) { url = gatewayWsUrl; }
  else {
    url = `ws://${host}:${gwPort}`;
  }
  ws = new WebSocket(url);

  ws.onopen = () => {
    // console.log('[OpenClaw] WS opened, waiting for challenge...');
    // Don't call doConnect() here — wait for the connect.challenge event.
    // The gateway sends it immediately after WS open. If we send connect
    // before receiving the challenge, the gateway accepts without device
    // identity and clears our scopes.
  };
  ws.onmessage = (evt) => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    // console.log('[OpenClaw] WS msg:', data.type, data.event || data.id || '', data);

    if (data.type === 'event' && data.event === 'connect.challenge') {
      const nonce = data.payload?.nonce;
      if (nonce) { connectNonce = nonce; doConnect(); }
      return;
    }
    if (data.type === 'res' && typeof data.id === 'string') {
      const pending = pendingResponses.get(data.id);
      if (pending) { pendingResponses.delete(data.id); data.ok === false || data.error ? pending.reject(new Error(data.error?.message || 'Request failed')) : pending.resolve(data.payload ?? data.result ?? data); }
      return;
    }
    if (data.type === 'event') handleEvent(data);
  };

  ws.onclose = (evt) => {
    connected = false; setStatus('disconnected');
    inputEl.disabled = true; sendBtn.disabled = true;
    if (attachBtn) attachBtn.disabled = true;
    if (fileInput) fileInput.disabled = true;
    pendingResponses.forEach(p => p.reject(new Error('Disconnected')));
    pendingResponses.clear(); hideTyping();
    if (!reconnectTimer) { reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWs(); }, 3000); }
  };
  ws.onerror = () => {};
}

function setStatus(state) { if (statusDot) statusDot.className = 'status-dot ' + state; }

// ── History ──
async function loadHistory() {
  try {
    const result = await sendReq('chat.history', { sessionKey: SESSION_KEY, limit: 1000 });
    const messages = result?.messages || [];
    if (messages.length > 0) {
      emptyState.style.display = 'none';
      msgEl.innerHTML = '';
      messages.forEach(m => {
        if (m.role === 'user' || m.role === 'assistant') {
          const content = typeof m.content === 'string' ? m.content :
            Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
          const images = extractImages(m);
          if ((content && content !== 'HEARTBEAT_OK' && content !== 'NO_REPLY') || images.length > 0) addMsg(m.role, content, images);
        }
      });
    } else {
      emptyState.innerHTML = '<div class="emoji">💬</div><p>Say something!</p>';
    }
  } catch(e) {
    console.warn('Failed to load history:', e.message);
    emptyState.innerHTML = '<div class="emoji">💬</div><p>Ready to chat!</p>';
  }
}

// ── Events ──
function extractText(msg) {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.filter(c => c.type === 'text').map(c => c.text).join('');
  if (msg && typeof msg === 'object') {
    if (typeof msg.text === 'string') return msg.text;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) return msg.content.filter(p => p.type === 'text').map(p => p.text).join('');
  }
  return '';
}

function extractImages(msg) {
  const images = [];
  const content = Array.isArray(msg) ? msg : (msg?.content && Array.isArray(msg.content)) ? msg.content : null;
  if (!content) return images;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image') {
      const source = block.source;
      if (source?.type === 'base64' && typeof source.data === 'string') {
        const mediaType = source.media_type || 'image/png';
        const url = source.data.startsWith('data:') ? source.data : `data:${mediaType};base64,${source.data}`;
        images.push(url);
      } else if (typeof block.url === 'string') {
        images.push(block.url);
      }
    } else if (block.type === 'image_url') {
      const imageUrl = block.image_url;
      if (typeof imageUrl?.url === 'string') images.push(imageUrl.url);
    }
  }
  return images;
}

let lastSeenSeq = -1;

function handleEvent(data) {
  const evt = data.event;
  const payload = data.payload;
  const seq = typeof data.seq === 'number' ? data.seq : -1;

  // Deduplicate: gateway sends each event twice with the same seq
  if (seq >= 0 && seq === lastSeenSeq) return;
  if (seq >= 0) lastSeenSeq = seq;

  if (evt === 'agent' && payload) {
    if (payload.sessionKey && payload.sessionKey !== SESSION_KEY) return;
    // Only use agent events for status (typing indicator), NOT for streaming text
    if (payload.status === 'thinking' || payload.status === 'running') { showTyping(); return; }
    if (payload.status === 'done' || payload.status === 'idle') { hideTyping(); waitingForReply = false; return; }
    return;
  }

  if (evt === 'chat' && payload) {
    if (payload.sessionKey && payload.sessionKey !== SESSION_KEY) return;
    if (payload.state === 'delta') {
      const text = extractText(payload.message);
      if (text) replaceStreamingAssistant(text);
      showTyping();
      return;
    }
    if (payload.state === 'final' || payload.state === 'aborted') {
      hideTyping(); waitingForReply = false;
      const text = extractText(payload.message);
      const images = extractImages(payload.message);

      // ── Auto-execute /tabs commands from assistant ──
      // If the assistant's reply contains a /tabs command on its own line, execute it locally
      if (text) {
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('/tabs ') || trimmedLine === '/tabs') {
            // Execute the command silently (don't show as user message, results go to gateway)
            handleTabsCommand(trimmedLine).then(() => updateTabStats());
          }
        }
      }

      const streamRow = msgEl.querySelector('.msg-row.assistant[data-streaming="true"]');
      const lastMsg = streamRow ? streamRow.querySelector('.msg.assistant') : null;
      if (lastMsg) {
        const trimmed = text?.trim();
        const isSuppressed = !trimmed || trimmed === 'HEARTBEAT_OK' || trimmed === 'NO_REPLY'
          || 'NO_REPLY'.startsWith(trimmed) || 'HEARTBEAT_OK'.startsWith(trimmed);
        if (!isSuppressed || images.length > 0) {
          streamRow.dataset.copyText = text || '';
          
          // Process MEDIA: lines for final streaming content
          const { cleanText, mediaImages } = parseMediaLines(text || '');
          const allImages = [...images, ...mediaImages];
          
          // Update the bubble content (no bubble-actions inside bubble in new layout)
          lastMsg.innerHTML = renderMarkdown(cleanText);
          lastMsg.classList.remove('streaming');
          if (allImages.length > 0) {
            let gallery = lastMsg.parentElement.querySelector('.msg-images');
            if (!gallery) {
              gallery = document.createElement('div');
              gallery.className = 'msg-images';
              lastMsg.insertAdjacentElement('afterend', gallery);
            }
            gallery.innerHTML = '';
            for (const url of allImages) {
              gallery.appendChild(createMediaElement(url));
            }
          }
          
          // ── Background MEDIA: recovery from stored transcript ──
          // The gateway strips MEDIA: lines from live events but stores them in transcript.
          // If we have no images yet, fetch the last stored message to check for MEDIA: lines.
          if (allImages.length === 0) {
            (async () => {
              try {
                const history = await sendReq('chat.history', { sessionKey: SESSION_KEY, limit: 1 });
                if (history?.messages?.[0]) {
                  const storedMsg = history.messages[0];
                  const storedText = storedMsg.content?.map(c => c.text || '').join('\n') || '';
                  const { mediaImages: recoveredImages } = parseMediaLines(storedText);
                  
                  if (recoveredImages.length > 0) {
                    // Find the message row we just rendered
                    const targetRow = msgEl.querySelector('.msg-row.assistant[data-streaming="false"]');
                    if (targetRow) {
                      let gallery = targetRow.querySelector('.msg-images');
                      if (!gallery) {
                        const bubble = targetRow.querySelector('.msg.assistant');
                        gallery = document.createElement('div');
                        gallery.className = 'msg-images';
                        bubble.insertAdjacentElement('afterend', gallery);
                      }
                      for (const url of recoveredImages) {
                        gallery.appendChild(createMediaElement(url));
                      }
                    }
                  }
                }
              } catch (err) {
                // Silently skip if history fetch fails - text is already shown
              }
            })();
          }
        }
        streamRow.dataset.streaming = 'false';
      } else if ((text && text.trim() !== 'HEARTBEAT_OK' && text.trim() !== 'NO_REPLY') || images.length > 0) {
        addMsg('assistant', text, images);
        
        // ── Background MEDIA: recovery for non-streaming final messages ──
        if (images.length === 0) {
          (async () => {
            try {
              const history = await sendReq('chat.history', { sessionKey: SESSION_KEY, limit: 1 });
              if (history?.messages?.[0]) {
                const storedMsg = history.messages[0];
                const storedText = storedMsg.content?.map(c => c.text || '').join('\n') || '';
                const { mediaImages: recoveredImages } = parseMediaLines(storedText);
                
                if (recoveredImages.length > 0) {
                  // Find the newest assistant message row (we just added it)
                  const targetRow = msgEl.querySelector('.msg-row.assistant');
                  if (targetRow) {
                    let gallery = targetRow.querySelector('.msg-images');
                    if (!gallery) {
                      const bubble = targetRow.querySelector('.msg.assistant');
                      gallery = document.createElement('div');
                      gallery.className = 'msg-images';
                      bubble.insertAdjacentElement('afterend', gallery);
                    }
                    for (const url of recoveredImages) {
                      gallery.appendChild(createMediaElement(url));
                    }
                  }
                }
              }
            } catch (err) {
              // Silently skip if history fetch fails - text is already shown
            }
          })();
        }
      }
      return;
    }
    if (payload.state === 'error') {
      hideTyping(); waitingForReply = false;
      addSystemMsg('Error: ' + (payload.errorMessage || 'unknown'));
      return;
    }
  }
}

// ── Tab Manager Slash Commands ──
async function handleTabsCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]; // "/tabs"
  const subCmd = parts[1] || 'query'; // default to query
  const args = parts.slice(2);

  let resultText = '';

  try {
    if (subCmd === 'help' || text === '/tabs help') {
      resultText = `**Tab Manager Commands:**

- \`/tabs\` or \`/tabs query\` — List all open tabs
- \`/tabs triage [filter]\` — Start batch tab triage (interactive)
- \`/tabs process [filter]\` — Alias for triage
- \`/tabs save <tab-id>\` — Save a specific tab to Karakeep
- \`/tabs close <tab-ids>\` — Close tabs by ID (comma-separated)
- \`/tabs close-batch <tab-ids>\` — Close multiple tabs (no warnings)
- \`/tabs dedupe\` — Find duplicate tabs (same URL)
- \`/tabs groups\` — List tab groups
- \`/tabs search <query>\` — Search tabs by title/URL
- \`/tabs help\` — Show this help

**Triage filters:** \`all\`, \`ungrouped\`, \`group:<name>\`, \`pinned\`, \`search:<query>\``;
      
      addMsg('assistant', resultText);
      // Send to gateway so the assistant sees it
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: `[Tab Manager] ${text}\n\n${resultText}`,
        deliver: false,
        idempotencyKey: uuid()
      });
      return true;
    }

    if (subCmd === 'query' || subCmd === 'list' || parts.length === 1) {
      // List all tabs
      const allTabs = await chrome.tabs.query({});
      const windows = {};
      
      // Group tabs by window
      allTabs.forEach(tab => {
        if (!windows[tab.windowId]) windows[tab.windowId] = [];
        windows[tab.windowId].push(tab);
      });

      // Get tab groups info
      let groups = {};
      try {
        const tabGroups = await chrome.tabGroups.query({});
        tabGroups.forEach(g => {
          groups[g.id] = g.title || `Group ${g.id}`;
        });
      } catch(e) {
        // Tab groups not available in all browsers
      }

      const windowIds = Object.keys(windows).sort();
      const totalTabs = allTabs.length;
      
      resultText = `[Tab Manager] /tabs query\nFound **${totalTabs}** tab${totalTabs !== 1 ? 's' : ''} across **${windowIds.length}** window${windowIds.length !== 1 ? 's' : ''}:\n\n`;
      
      windowIds.forEach((winId, idx) => {
        const tabs = windows[winId];
        resultText += `**Window ${idx + 1}** (${tabs.length} tab${tabs.length !== 1 ? 's' : ''})\n`;
        
        tabs.forEach(tab => {
          const indicators = [];
          if (tab.active) indicators.push('active');
          if (tab.pinned) indicators.push('pinned');
          if (tab.groupId !== -1 && groups[tab.groupId]) {
            indicators.push(`group: ${groups[tab.groupId]}`);
          }
          
          const status = indicators.length > 0 ? ` (${indicators.join(', ')})` : '';
          const title = tab.title || 'Untitled';
          const url = tab.url || '';
          
          resultText += `- [${tab.id}] ${title}${status}\n  ↳ \`${url}\`\n`;
        });
        
        resultText += '\n';
      });

      addMsg('assistant', resultText);
      
      // Send to gateway
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: resultText,
        deliver: false,
        idempotencyKey: uuid()
      });
      return true;
    }

    if (subCmd === 'close') {
      if (args.length === 0) {
        resultText = '[Tab Manager] /tabs close\n\n⚠️ Usage: `/tabs close <tab-ids>` (comma-separated)\nExample: `/tabs close 123,456,789`';
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      const idsStr = args.join(' ');
      const tabIds = idsStr.split(',').map(s => parseInt(s.trim())).filter(id => !isNaN(id));
      
      if (tabIds.length === 0) {
        resultText = '[Tab Manager] /tabs close\n\n⚠️ No valid tab IDs provided';
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      resultText = `[Tab Manager] /tabs close ${tabIds.join(',')}\n\n`;
      if (tabIds.length > 5) {
        resultText += `⚠️ **Closing ${tabIds.length} tabs** — that's a lot!\n\n`;
      }
      const results = [];
      
      for (const tabId of tabIds) {
        try {
          await chrome.tabs.remove(tabId);
          results.push(`✅ Closed tab ${tabId}`);
        } catch(e) {
          results.push(`❌ Failed to close tab ${tabId}: ${e.message}`);
        }
      }
      
      resultText += results.join('\n');
      addMsg('assistant', resultText);
      
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: resultText,
        deliver: false,
        idempotencyKey: uuid()
      });
      return true;
    }

    if (subCmd === 'dedupe') {
      const allTabs = await chrome.tabs.query({});
      const urlMap = {};
      
      // Group tabs by URL
      allTabs.forEach(tab => {
        const url = tab.url || '';
        if (!url || url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('chrome-extension://')) return;
        
        if (!urlMap[url]) urlMap[url] = [];
        urlMap[url].push(tab);
      });

      // Find duplicates (URLs with 2+ tabs)
      const dupes = Object.entries(urlMap).filter(([url, tabs]) => tabs.length > 1);
      
      if (dupes.length === 0) {
        resultText = '[Tab Manager] /tabs dedupe\n\n✅ No duplicate tabs found!';
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      resultText = `[Tab Manager] /tabs dedupe\nFound **${dupes.length}** duplicate URL${dupes.length !== 1 ? 's' : ''}:\n\n`;
      
      dupes.forEach(([url, tabs]) => {
        resultText += `**${url}**\n`;
        resultText += `  ${tabs.length} copies:\n`;
        
        tabs.forEach((tab, idx) => {
          const keep = idx === 0 ? ' ← **keep**' : ' ← would close';
          const indicators = [];
          if (tab.active) indicators.push('active');
          if (tab.pinned) indicators.push('pinned');
          const status = indicators.length > 0 ? ` (${indicators.join(', ')})` : '';
          
          resultText += `  - [${tab.id}] ${tab.title || 'Untitled'}${status}${keep}\n`;
        });
        
        resultText += '\n';
      });

      resultText += '\n💡 **Tip:** Use `/tabs close <ids>` to close the duplicates you want to remove';
      
      addMsg('assistant', resultText);
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: resultText,
        deliver: false,
        idempotencyKey: uuid()
      });
      return true;
    }

    if (subCmd === 'groups') {
      let groups = {};
      let groupsToTabs = {};
      
      try {
        const tabGroups = await chrome.tabGroups.query({});
        tabGroups.forEach(g => {
          groups[g.id] = { title: g.title || `Group ${g.id}`, color: g.color };
          groupsToTabs[g.id] = [];
        });

        const allTabs = await chrome.tabs.query({});
        allTabs.forEach(tab => {
          if (tab.groupId !== -1 && groups[tab.groupId]) {
            groupsToTabs[tab.groupId].push(tab);
          }
        });

        if (Object.keys(groups).length === 0) {
          resultText = '[Tab Manager] /tabs groups\n\n📁 No tab groups found';
        } else {
          resultText = `[Tab Manager] /tabs groups\nFound **${Object.keys(groups).length}** tab group${Object.keys(groups).length !== 1 ? 's' : ''}:\n\n`;
          
          Object.entries(groups).forEach(([groupId, info]) => {
            const tabs = groupsToTabs[groupId] || [];
            resultText += `**${info.title}** (${info.color}, ${tabs.length} tab${tabs.length !== 1 ? 's' : ''})\n`;
            
            tabs.forEach(tab => {
              const indicators = [];
              if (tab.active) indicators.push('active');
              if (tab.pinned) indicators.push('pinned');
              const status = indicators.length > 0 ? ` (${indicators.join(', ')})` : '';
              
              resultText += `  - [${tab.id}] ${tab.title || 'Untitled'}${status}\n`;
            });
            
            resultText += '\n';
          });
        }
      } catch(e) {
        resultText = '[Tab Manager] /tabs groups\n\n⚠️ Tab groups not supported in this browser';
      }

      addMsg('assistant', resultText);
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: resultText,
        deliver: false,
        idempotencyKey: uuid()
      });
      return true;
    }

    if (subCmd === 'search') {
      if (args.length === 0) {
        resultText = '[Tab Manager] /tabs search\n\n⚠️ Usage: `/tabs search <query>`\nExample: `/tabs search github`';
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      const query = args.join(' ').toLowerCase();
      const allTabs = await chrome.tabs.query({});
      
      const matches = allTabs.filter(tab => {
        const title = (tab.title || '').toLowerCase();
        const url = (tab.url || '').toLowerCase();
        return title.includes(query) || url.includes(query);
      });

      if (matches.length === 0) {
        resultText = `[Tab Manager] /tabs search "${args.join(' ')}"\n\n🔍 No tabs found matching "${args.join(' ')}"`;
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      resultText = `[Tab Manager] /tabs search "${args.join(' ')}"\nFound **${matches.length}** matching tab${matches.length !== 1 ? 's' : ''}:\n\n`;
      
      matches.forEach(tab => {
        const indicators = [];
        if (tab.active) indicators.push('active');
        if (tab.pinned) indicators.push('pinned');
        const status = indicators.length > 0 ? ` (${indicators.join(', ')})` : '';
        
        resultText += `- [${tab.id}] ${tab.title || 'Untitled'}${status}\n  ↳ \`${tab.url || ''}\`\n`;
      });

      addMsg('assistant', resultText);
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: resultText,
        deliver: false,
        idempotencyKey: uuid()
      });
      return true;
    }

    if (subCmd === 'triage' || subCmd === 'process') {
      // Parse filter: all (default), ungrouped, group:<name>, pinned, search:<query>
      const filterArg = args[0] || 'all';
      let filterType = 'all';
      let filterValue = '';
      
      if (filterArg.startsWith('group:')) {
        filterType = 'group';
        filterValue = filterArg.slice(6);
      } else if (filterArg.startsWith('search:')) {
        filterType = 'search';
        filterValue = filterArg.slice(7);
      } else if (filterArg === 'ungrouped') {
        filterType = 'ungrouped';
      } else if (filterArg === 'pinned') {
        filterType = 'pinned';
      }

      // Query tabs based on filter
      const allTabs = await chrome.tabs.query({});
      let filteredTabs = [];

      if (filterType === 'all') {
        filteredTabs = allTabs.filter(tab => {
          const url = tab.url || '';
          return !url.startsWith('chrome://') && !url.startsWith('edge://') && !url.startsWith('chrome-extension://');
        });
      } else if (filterType === 'ungrouped') {
        filteredTabs = allTabs.filter(tab => {
          const url = tab.url || '';
          const isUnattachable = url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('chrome-extension://');
          return !isUnattachable && tab.groupId === -1;
        });
      } else if (filterType === 'group') {
        try {
          const tabGroups = await chrome.tabGroups.query({});
          const targetGroup = tabGroups.find(g => 
            (g.title || '').toLowerCase() === filterValue.toLowerCase()
          );
          if (targetGroup) {
            filteredTabs = allTabs.filter(tab => tab.groupId === targetGroup.id);
          }
        } catch(e) {
          // Tab groups not supported
        }
      } else if (filterType === 'pinned') {
        filteredTabs = allTabs.filter(tab => {
          const url = tab.url || '';
          const isUnattachable = url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('chrome-extension://');
          return !isUnattachable && tab.pinned;
        });
      } else if (filterType === 'search') {
        const query = filterValue.toLowerCase();
        filteredTabs = allTabs.filter(tab => {
          const url = tab.url || '';
          const isUnattachable = url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('chrome-extension://');
          if (isUnattachable) return false;
          const title = (tab.title || '').toLowerCase();
          const urlLower = url.toLowerCase();
          return title.includes(query) || urlLower.includes(query);
        });
      }

      if (filteredTabs.length === 0) {
        resultText = `[Tab Triage] No tabs found matching filter: **${filterArg}**`;
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      // Build tab list message for the assistant
      resultText = `[Tab Triage] Starting batch triage of **${filteredTabs.length}** tab${filteredTabs.length !== 1 ? 's' : ''} (filter: ${filterArg})\n\nTabs to process:\n`;
      
      filteredTabs.forEach(tab => {
        resultText += `- [${tab.id}] ${tab.title || 'Untitled'} ← ${tab.url || ''}\n`;
      });

      addSystemMsg(`Starting triage of ${filteredTabs.length} tabs... The assistant will review each one.`);
      
      // Send to gateway with deliver: true to trigger the assistant
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: resultText,
        deliver: true,  // IMPORTANT: triggers agent turn
        idempotencyKey: uuid()
      });
      return true;
    }

    if (subCmd === 'save') {
      if (args.length === 0) {
        resultText = '[Tab Manager] /tabs save\n\n⚠️ Usage: `/tabs save <tab-id>`\nExample: `/tabs save 12345`';
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      const tabId = parseInt(args[0]);
      if (isNaN(tabId)) {
        resultText = '[Tab Manager] /tabs save\n\n⚠️ Invalid tab ID';
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      try {
        const tab = await chrome.tabs.get(tabId);
        const title = tab.title || 'Untitled';
        const url = tab.url || '';
        
        // Send to gateway with deliver: true so the assistant handles the actual Karakeep save
        resultText = `[Tab Manager] Save tab [${tabId}]: ${title} ← ${url}`;
        
        addSystemMsg(`Requesting save for tab ${tabId}: ${title}`);
        
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: true,  // The assistant will handle the save
          idempotencyKey: uuid()
        });
        
        // Note: Tab closing happens AFTER the assistant confirms the save
        // The assistant will send a message like "Saved! You can close it now"
        // and then we can close it manually or the assistant can use /tabs close
        
        return true;
      } catch(e) {
        resultText = `[Tab Manager] /tabs save\n\n❌ Tab ${tabId} not found: ${e.message}`;
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }
    }

    if (subCmd === 'close-batch') {
      if (args.length === 0) {
        resultText = '[Tab Manager] /tabs close-batch\n\n⚠️ Usage: `/tabs close-batch <tab-ids>` (comma-separated)\nExample: `/tabs close-batch 123,456,789`';
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      const idsStr = args.join(' ');
      const tabIds = idsStr.split(',').map(s => parseInt(s.trim())).filter(id => !isNaN(id));
      
      if (tabIds.length === 0) {
        resultText = '[Tab Manager] /tabs close-batch\n\n⚠️ No valid tab IDs provided';
        addMsg('assistant', resultText);
        await sendReq('chat.send', {
          sessionKey: SESSION_KEY,
          message: resultText,
          deliver: false,
          idempotencyKey: uuid()
        });
        return true;
      }

      resultText = `[Tab Manager] /tabs close-batch ${tabIds.join(',')}\n\n`;
      const results = [];
      
      for (const tabId of tabIds) {
        try {
          await chrome.tabs.remove(tabId);
          results.push(`✅ Closed tab ${tabId}`);
        } catch(e) {
          results.push(`❌ Failed to close tab ${tabId}: ${e.message}`);
        }
      }
      
      resultText += results.join('\n');
      addMsg('assistant', resultText);
      
      await sendReq('chat.send', {
        sessionKey: SESSION_KEY,
        message: resultText,
        deliver: false,
        idempotencyKey: uuid()
      });
      return true;
    }

    // Unknown subcommand
    resultText = `[Tab Manager] Unknown command: \`${text}\`\n\nUse \`/tabs help\` to see available commands`;
    addMsg('assistant', resultText);
    await sendReq('chat.send', {
      sessionKey: SESSION_KEY,
      message: resultText,
      deliver: false,
      idempotencyKey: uuid()
    });
    return true;

  } catch(e) {
    resultText = `[Tab Manager] Error: ${e.message}`;
    addMsg('assistant', resultText);
    await sendReq('chat.send', {
      sessionKey: SESSION_KEY,
      message: resultText,
      deliver: false,
      idempotencyKey: uuid()
    });
    return true;
  }
}

// ── Send ──
async function sendMessage() {
  hideCmdPicker();
  const text = inputEl.value.trim();
  const hasAttachments = pendingAttachments.length > 0;
  if ((!text && !hasAttachments) || !connected) return;

  // ── Slash Command Intercept ──
  if (text.startsWith('/tabs')) {
    // Show the command as user message
    addMsg('user', text);
    
    // Clear input
    inputEl.value = '';
    inputEl.style.height = 'auto';
    emptyState.style.display = 'none';
    
    // Handle the command locally
    await handleTabsCommand(text);
    updateTabStats();
    return;
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';
  emptyState.style.display = 'none';

  // Build display text
  const attachNames = pendingAttachments.map(a => `📎 ${a.fileName}`);
  const displayText = [text, ...attachNames].filter(Boolean).join('\n');
  addMsg('user', displayText);

  // Build attachments payload
  const attachments = pendingAttachments.map(a => ({
    mimeType: a.mimeType,
    fileName: a.fileName,
    content: a.base64,
  }));

  // Clear pending
  pendingAttachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
  pendingAttachments.length = 0;
  renderAttachmentPreview();

  showTyping();
  waitingForReply = true;
  try {
    // Build tab context from attached tabs
    let tabContext = '';
    if (attachedTabs.size > 0) {
      const tabLines = [...attachedTabs.values()].map(t => `- ${t.title || 'Untitled'}: ${t.url || ''}`);
      tabContext = `\n\n[Tab Context]\n${tabLines.join('\n')}`;
    }
    const params = {
      sessionKey: SESSION_KEY,
      message: (text || '(attached files)') + tabContext,
      deliver: false,
      idempotencyKey: uuid(),
    };
    if (attachments.length > 0) params.attachments = attachments;
    await sendReq('chat.send', params);
  } catch(e) {
    addSystemMsg('Send failed: ' + e.message);
    hideTyping(); waitingForReply = false;
  }
}

// ── Render (reverse order: newest at top) ──

// Bubble copy button — absolute top-right inside bubble (assistant only)
function createBubbleActions() {
  const actions = document.createElement('div');
  actions.className = 'msg-bubble-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msg-action-btn';
  copyBtn.dataset.action = 'copy';
  copyBtn.title = 'Copy message';
  copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  actions.appendChild(copyBtn);

  return actions;
}

// Footer actions wrapper: TTS + Copy — shown on group hover via .msg-footer-actions
function createFooterActions(role) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-footer-actions';

  // TTS button
  const ttsBtn = document.createElement('button');
  ttsBtn.type = 'button';
  ttsBtn.className = 'msg-action-btn';
  ttsBtn.dataset.action = 'tts';
  ttsBtn.title = 'Read aloud';
  ttsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  wrap.appendChild(ttsBtn);

  // Copy button (also in footer for user messages where bubble copy button isn't shown)
  if (role === 'user') {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-action-btn';
    copyBtn.dataset.action = 'copy';
    copyBtn.title = 'Copy message';
    copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    wrap.appendChild(copyBtn);
  }

  return wrap;
}

// Build a message row in webchat style:
//   .msg-row.{role}          (full-width column, user right-aligned)
//   ├── .msg-header             (avatar + name + time — above content)
//   ├── .msg.{role}             (no bubble for assistant; bubble for user)
//   ├── .msg-images             (optional gallery)
//   └── .msg-group-footer        (footer actions: copy + tts; hidden until hover)
function buildMsgRow(role, contentHtml, timeStr, images) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  // ── Header: avatar + name + timestamp ──
  const header = document.createElement('div');
  header.className = 'msg-header';

  const avatar = document.createElement('div');
  avatar.className = role === 'user' ? 'msg-avatar user-avatar' : 'msg-avatar';
  const avatarImg = document.createElement('img');
  avatarImg.src = role === 'user' ? 'icons/user-avatar-64.png' : 'icons/assistant-avatar-64.png';
  avatarImg.className = 'avatar-img';
  avatarImg.alt = role === 'user' ? 'You' : 'Assistant';
  avatarImg.onerror = () => { avatarImg.style.display = 'none'; };
  avatar.appendChild(avatarImg);
  header.appendChild(avatar);

  const nameEl = document.createElement('span');
  nameEl.className = 'msg-sender-name';
  nameEl.textContent = role === 'user' ? 'You' : displayName;
  header.appendChild(nameEl);

  const timeEl = document.createElement('span');
  timeEl.className = 'msg-group-timestamp';
  timeEl.textContent = timeStr;
  header.appendChild(timeEl);

  row.appendChild(header);

  // ── Message body ──
  const bubble = document.createElement('div');
  bubble.className = `msg ${role}`;
  // Both roles use innerHTML: user content is pre-escaped HTML (safe), assistant is rendered markdown
  bubble.innerHTML = contentHtml;
  row.appendChild(bubble);

  // ── Images/audio gallery (below body) ──
  if (images && images.length > 0) {
    const gallery = document.createElement('div');
    gallery.className = 'msg-images';
    for (const url of images) {
      gallery.appendChild(createMediaElement(url));
    }
    row.appendChild(gallery);
  }

  // ── Footer: copy + TTS actions (shown on row hover) ──
  const footer = document.createElement('div');
  footer.className = 'msg-group-footer';
  footer.appendChild(createFooterActions(role));
  row.appendChild(footer);

  return row;
}

function formatMsgTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ── MEDIA: line processing ──
function isAudioUrl(url) {
  return /\.(mp3|wav|ogg|m4a|aac|webm|flac|opus)([?#]|$)/i.test(url);
}

function createMediaElement(url) {
  if (isAudioUrl(url)) {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    audio.className = 'msg-audio';
    audio.preload = 'metadata';
    return audio;
  }
  const img = document.createElement('img');
  img.src = url;
  img.className = 'msg-image';
  img.addEventListener('click', () => window.open(url, '_blank'));
  return img;
}

function parseMediaLines(content) {
  const lines = content.split('\n');
  const mediaImages = [];
  const cleanLines = [];
  
  for (const line of lines) {
    const match = line.match(/^MEDIA:(.+)$/); 
    if (match) {
      const pathOrUrl = match[1].trim();
      const mediaUrl = convertToMediaUrl(pathOrUrl);
      if (mediaUrl) {
        mediaImages.push(mediaUrl);
      }
      // Skip this line - don't add to cleanLines
    } else {
      cleanLines.push(line);
    }
  }
  
  return {
    cleanText: cleanLines.join('\n'),
    mediaImages
  };
}

function convertToMediaUrl(pathOrUrl) {
  // If it's already an HTTP(S) URL, use as-is
  if (pathOrUrl.match(/^https?:\/\//)) {
    return pathOrUrl;
  }
  
  // Local path → gateway assistant-media endpoint (same as Control UI)
  if (pathOrUrl.startsWith('/') || pathOrUrl.startsWith('~')) {
    const gatewayBaseUrl = getGatewayHttpUrl();
    if (gatewayBaseUrl) {
      const params = new URLSearchParams({ source: pathOrUrl });
      if (token) params.set('token', token);
      return `${gatewayBaseUrl}/__openclaw__/assistant-media?${params.toString()}`;
    }
  }
  
  return null;
}

function getGatewayHttpUrl() {
  // Convert WebSocket URL to HTTP URL
  if (gatewayWsUrl) {
    return gatewayWsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  }
  
  // Fallback: derive from gateway WS URL or host/port
  const gwUrl = gatewayWsUrl || `ws://${host}:${gwPort}`;
  return gwUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
}

function addMsg(role, content, images) {
  if (role === 'system') {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = content;
    msgEl.insertBefore(div, msgEl.firstChild);
    return;
  }

  // Process MEDIA: lines for assistant messages
  let processedContent = content;
  let allImages = images ? [...images] : [];
  
  if (role === 'assistant' && content) {
    const { cleanText, mediaImages } = parseMediaLines(content);
    processedContent = cleanText;
    allImages = allImages.concat(mediaImages);
  }

  const timeStr = formatMsgTime(new Date());
  // User content: escape HTML so innerHTML is safe; assistant: render markdown
  const contentHtml = role === 'assistant' ? renderMarkdown(processedContent) : escapeHtml(processedContent || '').replace(/\n/g, '<br>');
  const row = buildMsgRow(role, contentHtml, timeStr, allImages);
  row.dataset.copyText = content || '';
  msgEl.insertBefore(row, msgEl.firstChild);
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  msgEl.insertBefore(div, msgEl.firstChild);
}

function replaceStreamingAssistant(fullText) {
  emptyState.style.display = 'none';
  let row = msgEl.querySelector('.msg-row.assistant[data-streaming="true"]');
  if (!row) {
    const timeStr = formatMsgTime(new Date());
    row = buildMsgRow('assistant', '', timeStr, []);
    row.dataset.streaming = 'true';
    msgEl.insertBefore(row, msgEl.firstChild);
  }

  // Process MEDIA: lines for streaming messages
  const { cleanText, mediaImages } = parseMediaLines(fullText || '');
  
  row.dataset.copyText = fullText || '';
  const bubble = row.querySelector('.msg.assistant');
  if (bubble) {
    // No bubble-actions inside the bubble in new layout (they're in the footer)
    bubble.innerHTML = renderMarkdown(cleanText);
    bubble.classList.add('streaming');
  }
  
  // Update or add media images
  if (mediaImages.length > 0) {
    let gallery = row.querySelector('.msg-images');
    if (!gallery) {
      gallery = document.createElement('div');
      gallery.className = 'msg-images';
      row.appendChild(gallery);
    }
    gallery.innerHTML = '';
    for (const url of mediaImages) {
      gallery.appendChild(createMediaElement(url));
    }
  }
}

function showTyping() { typingEl.style.display = 'block'; }
function hideTyping() { typingEl.style.display = 'none'; }
function scrollToBottom() { /* newest is at top, always visible */ }

// ── Basic Markdown ──
function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const safeLang = (lang || '').trim();
    return `<div class="code-block"><button class="code-copy-btn" type="button">Copy</button><pre><code${safeLang ? ` data-lang="${safeLang}"` : ''}>${code.trim()}</code></pre></div>`;
  });
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>(\n|$))+/g, (match) => `<ul>${match}</ul>`);
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p>\s*<(pre|ul|ol)/g, '<$1');
  html = html.replace(/<\/(pre|ul|ol)>\s*<\/p>/g, '</$1>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#FF5A36">$1</a>');
  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Init ──
// Keep-alive port — also used for all background communication
const bgPort = chrome.runtime.connect({ name: 'sidepanel-alive' });

// Handle messages from background script (including context menu selections)
bgPort.onMessage.addListener((msg) => {
  if (msg.type === 'CONTEXT_MENU_SELECTION') {
    handleContextMenuSelection(msg)
  }
})

// ── Drag-and-drop file attachment ──
const inputArea = document.querySelector('.input-area');
inputArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  inputArea.classList.add('drag-over');
});
inputArea.addEventListener('dragleave', () => {
  inputArea.classList.remove('drag-over');
});
inputArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  inputArea.classList.remove('drag-over');
  if (!connected) return;
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      addSystemMsg(`Max ${MAX_ATTACHMENTS} attachments at once`);
      break;
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      addSystemMsg(`${file.name} too large (max 5 MB)`);
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      pendingAttachments.push({
        file,
        base64,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      });
    } catch (err) {
      addSystemMsg(`Failed to read ${file.name}: ${err.message}`);
    }
  }
  renderAttachmentPreview();
});

// ── Voice Recording (Speech-to-Text) — Chunked Batch Mode ──
// Records audio with MediaRecorder, sends chunks every 3s to HTTP batch endpoint
// for live transcription feedback. More reliable than realtime WS.
const MAX_RECORDING_DURATION_MS = 60000; // 60 seconds
const CHUNK_INTERVAL_MS = 3000; // Send chunk for transcription every 3s

let recordingTimeout = null;
let isRecording = false;
let finalText = '';
let mediaRecorder = null;
let recordingStream = null;
let chunkTimer = null;
let pendingChunks = []; // Collect audio data between chunk intervals
let chunkInFlight = false; // Prevent overlapping chunk requests

micBtn?.addEventListener('click', async () => {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
});

function getSttHttpUrl() {
  if (sttUrl) return sttUrl;
  const gwUrl = gatewayWsUrl || `ws://127.0.0.1:${gwPort}`;
  const base = gwUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
  return `${base}/v1/audio/transcriptions`;
}

async function transcribeBlob(blob) {
  const url = getSttHttpUrl();
  const model = sttModel || 'deepdml/faster-whisper-large-v3-turbo-ct2';
  const fd = new FormData();
  fd.append('file', blob, 'chunk.webm');
  fd.append('model', model);
  // No language param — let Whisper auto-detect (supports ~100 languages)
  fd.append('prompt', 'OpenClaw');
  const headers = {};
  if (sttApiKey) headers['Authorization'] = `Bearer ${sttApiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  if (!res.ok) throw new Error(`STT ${res.status}`);
  const data = await res.json();
  return (data.text || '').trim();
}

async function startRecording() {
  try {
    finalText = '';
    inputEl.value = '';
    pendingChunks = [];
    chunkInFlight = false;

    recordingStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    // Use MediaRecorder to capture audio in webm/opus chunks
    mediaRecorder = new MediaRecorder(recordingStream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm'
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) pendingChunks.push(e.data);
    };

    // Request data every 500ms so we have fine-grained chunks
    mediaRecorder.start(500);

    isRecording = true;
    updateRecordingUI('recording');

    // Every CHUNK_INTERVAL_MS, grab accumulated audio and transcribe
    chunkTimer = setInterval(async () => {
      if (!isRecording || pendingChunks.length === 0 || chunkInFlight) return;
      chunkInFlight = true;
      try {
        // Build a blob from all chunks so far (cumulative for better context)
        const allChunks = [...pendingChunks];
        const blob = new Blob(allChunks, { type: mediaRecorder.mimeType });
        if (blob.size < 1000) { chunkInFlight = false; return; } // Skip tiny chunks
        const text = await transcribeBlob(blob);
        if (text) {
          // Check for voice trigger phrases at the end
          const trigger = detectVoiceTrigger(text);
          if (trigger) {
            inputEl.value = trigger.cleanedText;
            skipFinalTranscription = true; // Don't overwrite with final transcription
            chunkInFlight = false; // Release lock before stopping
            if (trigger.action === 'send') {
              await stopRecording();
              // Defer sendMessage to next microtask to avoid any re-entry issues
              if (inputEl.value.trim()) setTimeout(() => sendMessage(), 0);
            } else if (trigger.action === 'cancel') {
              await stopRecording();
              inputEl.value = ''; // Clear textarea completely
            } else if (trigger.action === 'stop') {
              await stopRecording();
              // Text stays in textarea for editing
            }
            return; // Skip normal flow
          }
          inputEl.value = text; // Show cumulative transcription
        }
      } catch (err) {
        console.warn('Chunk transcription failed:', err);
      }
      chunkInFlight = false;
    }, CHUNK_INTERVAL_MS);

    recordingTimeout = setTimeout(() => {
      if (isRecording) { stopRecording(); addSystemMsg('Recording stopped (60s limit)'); }
    }, MAX_RECORDING_DURATION_MS);
  } catch (err) {
    addSystemMsg('Mic error: ' + (err.message || String(err)));
    cleanupRecording();
    resetRecordingUI();
  }
}

// ── Voice trigger detection ─────────────────────────────────────────────────
const VOICE_TRIGGERS = [
  { phrases: ['over', 'over.'], action: 'send' },
  { phrases: ['cancel', 'cancel.'], action: 'cancel' },
  { phrases: ['stop', 'stop.'], action: 'stop' },
];

function detectVoiceTrigger(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const { phrases, action } of VOICE_TRIGGERS) {
    for (const phrase of phrases) {
      const escaped = phrase.replace('.', '[.]');
      const re = new RegExp('\\b' + escaped + '[\\s.,!?]*$', 'i');
      if (re.test(lower)) {
        const stripRe = new RegExp('\\s*\\b' + phrase.replace('.', '') + '[\\s.,!?]*$', 'i');
        const cleanedText = trimmed.replace(stripRe, '').trim();
        return { action, cleanedText };
      }
    }
  }
  return null;
}

function cleanupRecording() {
  if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch {}
  }
  mediaRecorder = null;
  if (recordingStream) { recordingStream.getTracks().forEach(t => t.stop()); recordingStream = null; }
  pendingChunks = [];
  chunkInFlight = false;
}

let skipFinalTranscription = false;

async function stopRecording() {
  if (recordingTimeout) { clearTimeout(recordingTimeout); recordingTimeout = null; }
  if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
  isRecording = false;
  updateRecordingUI('processing');

  try {
    // Stop recorder and wait for final data
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        mediaRecorder.onstop = resolve;
        mediaRecorder.stop();
      });
    }

    // Transcribe the full recording for best accuracy (skip if voice trigger already handled it)
    if (!skipFinalTranscription && pendingChunks.length > 0) {
      const fullBlob = new Blob(pendingChunks, { type: 'audio/webm' });
      if (fullBlob.size > 1000) {
        const text = await transcribeBlob(fullBlob);
        if (text) finalText = text;
      }
    }
  } catch (err) {
    console.warn('Final transcription failed:', err);
  }

  const wasVoiceTriggered = skipFinalTranscription;
  skipFinalTranscription = false;

  cleanupRecording();
  resetRecordingUI();

  // If voice trigger already set the text, don't overwrite
  if (wasVoiceTriggered) return;

  if (finalText.trim()) {
    inputEl.value = finalText.trim();
    // Don't auto-send — let user review, edit, or discard before hitting Send
    inputEl.focus();
  } else {
    addSystemMsg('No speech detected');
  }
}

function updateRecordingUI(state) {
  const micIcon = micBtn.querySelector('.mic-icon');
  const recordingIcon = micBtn.querySelector('.recording-icon');
  const spinnerIcon = micBtn.querySelector('.spinner-icon');
  
  if (state === 'recording') {
    micIcon.style.display = 'none';
    recordingIcon.style.display = 'block';
    spinnerIcon.style.display = 'none';
    micBtn.classList.add('recording');
    micBtn.classList.remove('processing');
    micBtn.title = 'Stop recording';
    sendBtn.disabled = true;
    inputEl.readOnly = true;
  } else if (state === 'processing') {
    micIcon.style.display = 'none';
    recordingIcon.style.display = 'none';
    spinnerIcon.style.display = 'block';
    micBtn.classList.remove('recording');
    micBtn.classList.add('processing');
    micBtn.title = 'Transcribing...';
    sendBtn.disabled = true;
    inputEl.readOnly = true;
  } else {
    micIcon.style.display = 'block';
    recordingIcon.style.display = 'none';
    spinnerIcon.style.display = 'none';
    micBtn.classList.remove('recording', 'processing');
    micBtn.title = 'Voice input';
    sendBtn.disabled = false;
    inputEl.readOnly = false;
  }
}

function resetRecordingUI() {
  isRecording = false;
  updateRecordingUI('idle');
}

const bgPending = new Map();
let portMsgId = 0;

bgPort.onMessage.addListener((msg) => {
  if (msg._id != null && bgPending.has(msg._id)) {
    bgPending.get(msg._id)(msg);
    bgPending.delete(msg._id);
  }
});

function sendBg(message) {
  return new Promise((resolve) => {
    const id = ++portMsgId;
    bgPending.set(id, resolve);
    bgPort.postMessage({ ...message, _id: id });
    // Timeout after 3s
    setTimeout(() => { if (bgPending.has(id)) { bgPending.delete(id); resolve({ ok: false }); } }, 3000);
  });
}

function fireBg(message) {
  try { bgPort.postMessage(message); } catch(e) {}
}

// ── Emoji Picker ──
const EMOJI_CATEGORIES = [
  {
    name: 'Smileys',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
      '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰',
      '😘', '😗', '😙', '😚', '☺️', '😋', '😛', '😝',
      '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤩',
      '😐', '😑', '😶', '🙄', '😏', '😣', '😥', '😮',
      '🤐', '😯', '😪', '😫', '😴', '😌', '😛', '😜'
    ]
  },
  {
    name: 'Hands',
    emojis: [
      '👍', '👎', '👊', '✊', '🤛', '👏', '🙌', '👐',
      '🤝', '🙏', '✍️', '💅', '🤳', '💁', '💆', '💇',
      '💈', '🤦', '🤷', '🙇', '💁', '🙅', '🙆', '🤷',
      '✋', '🤚', '👋', '🤙', '👌', '✌️', '🤞', '🤟'
    ]
  },
  {
    name: 'Hearts',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖖',
      '💔', '❣️', '💕', '💖', '💗', '💓', '💞', '💘',
      '💝', '💟', '♥️', '💝', '💟', '♥️', '😍', '🥰'
    ]
  },
  {
    name: 'Objects',
    emojis: [
      '💻', '📱', '⌨️', '💾', '💿', '📀', '🖥', '🖱',
      '⏰', '⌛', '📡', '🔋', '🔌', '💡', '🔦', '🕯',
      '📖', '📚', '📑', '📓', '✂️', '📌', '📎', '🔒',
      '🔑', '🔨', '🛠', '💣', '🔫', '🚪', '🚽', '🚿'
    ]
  },
  {
    name: 'Animals',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🦝', '🐻',
      '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽',
      '🐸', '🐙', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔',
      '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦩'
    ]
  },
  {
    name: 'Food',
    emojis: [
      '🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈',
      '🍒', '🍑', '🥝', '🥑', '🍅', '🥒', '🥕', '🌽',
      '🌶', '🥬', '🥒', '🥦', '🧄', '🧅', '🍞', '🥐',
      '🥖', '🧀', '🥚', '🍳', '🥓', '🥞', '🍔', '🍟'
    ]
  },
  {
    name: 'Symbols',
    emojis: [
      '✅', '✔️', '✖️', '❌', '❗', '❓', '⁉️', '‼️',
      '➡️', '⬅️', '⬆️', '⬇️', '↔️', '↕️', '↪️', '↩️',
      '⤴️', '⤵️', '⏪', '⏩', '⏫', '⏬', '▶️', '⏸',
      '⏯', '⏹', '⏺', '⏏', '🔺', '🔻', '🔸', '🔹'
    ]
  }
];

const emojiBtn = document.getElementById('emojiBtn');
let emojiPickerEl = null;
let emojiPickerVisible = false;

// Shortcode → emoji map for :colon: autocomplete
const EMOJI_SHORTCODES = {
  // Smileys
  grinning:'😀', smile:'😃', grin:'😄', beaming:'😁', laughing:'😆',
  sweat_smile:'😅', joy:'😂', rofl:'🤣', blush:'😊', innocent:'😇',
  slightly_smiling:'🙂', upside_down:'🙃', wink:'😉', relaxed:'😌',
  heart_eyes:'😍', love:'🥰', kiss:'😘', kissing:'😗', kissing_smiling:'😙',
  kissing_closed:'😚', yum:'😋', tongue:'😛', stuck_out_tongue:'😝',
  crazy:'🤪', monocle:'🧐', nerd:'🤓', sunglasses:'😎', cool:'😎',
  star_struck:'🤩', expressionless:'😑', neutral:'😐', no_mouth:'😶',
  eye_roll:'🙄', smirk:'😏', pensive:'😣', worried:'😥', surprised:'😮',
  zipper_mouth:'🤐', astonished:'😯', sleepy:'😪', tired:'😫', sleeping:'😴',
  think:'🤔', thinking:'🤔', shush:'🤫', liar:'🤥', hug:'🤗', mind_blown:'🤯',
  party:'🥳', disguised:'🥸', sad:'😢', cry:'😢', sob:'😭', angry:'😠',
  rage:'🤬', skull:'💀', poop:'💩', clown:'🤡', ghost:'👻', alien:'👽',
  robot:'🤖', wave:'👋', ok:'👌', thumbsup:'👍', thumbs_up:'👍',
  '+1':'👍', thumbsdown:'👎', '-1':'👎', thumbs_down:'👎',
  punch:'👊', fist:'✊', clap:'👏', raised_hands:'🙌', handshake:'🤝',
  pray:'🙏', writing:'✍️', muscle:'💪', point_up:'☝️', point_down:'👇',
  point_left:'👈', point_right:'👉', middle_finger:'🖕', victory:'✌️',
  crossed_fingers:'🤞', rock:'🤘', shaka:'🤙',
  // Hearts
  heart:'❤️', red_heart:'❤️', orange_heart:'🧡', yellow_heart:'💛',
  green_heart:'💚', blue_heart:'💙', purple_heart:'💜', black_heart:'🖤',
  broken_heart:'💔', sparkling_heart:'💖', fire:'🔥', flame:'🔥',
  star:'⭐', sparkles:'✨', boom:'💥', 100:'💯', hundred:'💯',
  // Objects
  laptop:'💻', phone:'📱', keyboard:'⌨️', computer:'🖥', bulb:'💡',
  book:'📖', books:'📚', lock:'🔒', key:'🔑', hammer:'🔨', tools:'🛠',
  // Animals
  dog:'🐶', cat:'🐱', mouse:'🐭', hamster:'🐹', rabbit:'🐰', fox:'🦊',
  bear:'🐻', panda:'🐼', tiger:'🐯', lion:'🦁', cow:'🐮', pig:'🐷',
  frog:'🐸', monkey:'🐵', see_no_evil:'🙈', hear_no_evil:'🙉', speak_no_evil:'🙊',
  chicken:'🐔', penguin:'🐧', bird:'🐦', eagle:'🦅',
  // Food
  apple:'🍎', orange:'🍊', lemon:'🍋', banana:'🍌', watermelon:'🍉',
  grapes:'🍇', strawberry:'🍓', cherry:'🍒', peach:'🍑', avocado:'🥑',
  pizza:'🍕', burger:'🍔', fries:'🍟', hotdog:'🌭', taco:'🌮',
  beer:'🍺', wine:'🍷', coffee:'☕', tea:'🍵', cake:'🎂', cookie:'🍪',
  // Symbols
  check:'✅', x:'❌', exclamation:'❗', question:'❓', warning:'⚠️',
  arrow_right:'➡️', arrow_left:'⬅️', arrow_up:'⬆️', arrow_down:'⬇️',
  play:'▶️', pause:'⏸', stop:'⏹',
  // Misc
  rocket:'🚀', eyes:'👀', eye:'👁', brain:'🧠', skull_crossbones:'☠️',
  trophy:'🏆', medal:'🥇', crown:'👑', gem:'💎', money:'💰',
  chart:'📈', chart_down:'📉', pin:'📌', paperclip:'📎', scissors:'✂️',
  mailbox:'📬', envelope:'✉️', bell:'🔔', mega:'📣', speaker:'🔊',
  mute:'🔇', mag:'🔍', search:'🔍', link:'🔗', gear:'⚙️', wrench:'🔧',
  shield:'🛡', clock:'🕐', hourglass:'⏳', zap:'⚡', snowflake:'❄️',
  sun:'☀️', moon:'🌙', cloud:'☁️', rainbow:'🌈', umbrella:'☂️',
  tada:'🎉', confetti:'🎊', balloon:'🎈', gift:'🎁', ribbon:'🎀',
  pirate:'💬', flag:'🚩', can:'🥫', banana:'🍌',
};
const SHORTCODE_ENTRIES = Object.entries(EMOJI_SHORTCODES);

// Inline :shortcode: autocomplete state
let emojiInlineEl = null;
let emojiInlineVisible = false;
let emojiInlineMatches = [];
let emojiInlineIndex = -1;
let emojiInlineStart = -1;

function createEmojiPicker() {
  if (emojiPickerEl) return emojiPickerEl;
  
  emojiPickerEl = document.createElement('div');
  emojiPickerEl.className = 'emoji-picker';
  
  // Prevent blur when clicking picker
  emojiPickerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  
  // Header with search
  const header = document.createElement('div');
  header.className = 'emoji-picker-header';
  const searchInput = document.createElement('input');
  searchInput.className = 'emoji-search';
  searchInput.type = 'text';
  searchInput.placeholder = 'Search emoji...';
  header.appendChild(searchInput);
  emojiPickerEl.appendChild(header);
  
  // Content container
  const content = document.createElement('div');
  content.className = 'emoji-picker-content';
  
  function renderCategories(filter) {
    content.innerHTML = '';
    const q = (filter || '').toLowerCase();
    EMOJI_CATEGORIES.forEach(category => {
      const filtered = q ? category.emojis.filter(e => {
        // Simple name matching: category name or common keywords
        return category.name.toLowerCase().includes(q);
      }) : category.emojis;
      if (q && filtered.length === 0) return;
      
      const categoryDiv = document.createElement('div');
      categoryDiv.className = 'emoji-category';
      const label = document.createElement('div');
      label.className = 'emoji-category-label';
      label.textContent = category.name;
      categoryDiv.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      (q ? filtered : category.emojis).forEach(emoji => {
        const item = document.createElement('div');
        item.className = 'emoji-item';
        item.textContent = emoji;
        item.addEventListener('click', () => insertEmoji(emoji));
        grid.appendChild(item);
      });
      categoryDiv.appendChild(grid);
      content.appendChild(categoryDiv);
    });
  }
  
  renderCategories();
  emojiPickerEl.appendChild(content);
  
  // Search filtering
  searchInput.addEventListener('input', () => {
    renderCategories(searchInput.value.trim());
  });
  
  // Store ref for focus
  emojiPickerEl._searchInput = searchInput;
  
  const inputWrapper = document.querySelector('.input-wrapper');
  inputWrapper.appendChild(emojiPickerEl);
  
  return emojiPickerEl;
}

function showEmojiPicker() {
  const picker = createEmojiPicker();
  picker.classList.add('visible');
  emojiPickerVisible = true;
  if (picker._searchInput) {
    picker._searchInput.value = '';
    setTimeout(() => picker._searchInput.focus(), 50);
  }
}

function hideEmojiPicker() {
  if (emojiPickerEl) {
    emojiPickerEl.classList.remove('visible');
  }
  emojiPickerVisible = false;
}

function insertEmoji(emoji) {
  const start = inputEl.selectionStart;
  const end = inputEl.selectionEnd;
  const text = inputEl.value;
  
  // Insert emoji at cursor position
  inputEl.value = text.substring(0, start) + emoji + text.substring(end);
  
  // Move cursor after emoji
  const newPos = start + emoji.length;
  inputEl.setSelectionRange(newPos, newPos);
  
  // Auto-resize textarea
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  
  // Focus back to textarea
  inputEl.focus();
  
  // Close picker
  hideEmojiPicker();
}

// Emoji button click handler
emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (emojiPickerVisible) {
    hideEmojiPicker();
  } else {
    // Hide command picker if open
    hideCmdPicker();
    showEmojiPicker();
  }
});

// Close emoji picker when clicking outside
document.addEventListener('click', (e) => {
  if (emojiPickerVisible && 
      !emojiPickerEl?.contains(e.target) && 
      e.target !== emojiBtn &&
      !emojiBtn.contains(e.target)) {
    hideEmojiPicker();
  }
});

// Close emoji picker on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && emojiPickerVisible) {
    hideEmojiPicker();
    inputEl.focus();
  }
  // Ctrl+. to toggle emoji picker
  if (e.key === '.' && e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (emojiPickerVisible) {
      hideEmojiPicker();
      inputEl.focus();
    } else {
      hideCmdPicker();
      showEmojiPicker();
    }
  }
});

// ── Inline :shortcode: autocomplete ─────────────────────────────────────────
(function setupEmojiInline() {
  emojiInlineEl = document.createElement('div');
  emojiInlineEl.className = 'emoji-inline-popup';
  emojiInlineEl.style.display = 'none';
  document.querySelector('.input-wrapper').appendChild(emojiInlineEl);

  function showInline(matches) {
    emojiInlineMatches = matches;
    emojiInlineIndex = 0;
    emojiInlineEl.innerHTML = '';
    matches.forEach(([code, emoji], i) => {
      const row = document.createElement('div');
      row.className = 'emoji-inline-item' + (i === 0 ? ' active' : '');
      row.innerHTML = `<span class="emoji-inline-icon">${emoji}</span><span class="emoji-inline-code">:${code}:</span>`;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickInline(i);
      });
      emojiInlineEl.appendChild(row);
    });
    emojiInlineEl.style.display = 'block';
    emojiInlineVisible = true;
  }

  function hideInline() {
    emojiInlineEl.style.display = 'none';
    emojiInlineVisible = false;
    emojiInlineMatches = [];
    emojiInlineIndex = -1;
    emojiInlineStart = -1;
  }

  function pickInline(idx) {
    const [code, emoji] = emojiInlineMatches[idx];
    const val = inputEl.value;
    const before = val.substring(0, emojiInlineStart);
    const after = val.substring(inputEl.selectionStart);
    inputEl.value = before + emoji + after;
    const pos = before.length + emoji.length;
    inputEl.setSelectionRange(pos, pos);
    inputEl.focus();
    hideInline();
  }

  inputEl.addEventListener('input', () => {
    const pos = inputEl.selectionStart;
    const text = inputEl.value.substring(0, pos);
    const colonIdx = text.lastIndexOf(':');
    if (colonIdx === -1 || pos - colonIdx < 2 || pos - colonIdx > 20) {
      if (emojiInlineVisible) hideInline();
      return;
    }
    const fragment = text.substring(colonIdx + 1);
    if (/\s/.test(fragment) || fragment.includes(':')) {
      if (emojiInlineVisible) hideInline();
      return;
    }
    const q = fragment.toLowerCase();
    const matches = SHORTCODE_ENTRIES.filter(([code]) => code.startsWith(q)).slice(0, 8);
    if (matches.length === 0) {
      if (emojiInlineVisible) hideInline();
      return;
    }
    emojiInlineStart = colonIdx;
    showInline(matches);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (!emojiInlineVisible) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      emojiInlineIndex = Math.min(emojiInlineIndex + 1, emojiInlineMatches.length - 1);
      emojiInlineEl.querySelectorAll('.emoji-inline-item').forEach((el, i) => el.classList.toggle('active', i === emojiInlineIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      emojiInlineIndex = Math.max(emojiInlineIndex - 1, 0);
      emojiInlineEl.querySelectorAll('.emoji-inline-item').forEach((el, i) => el.classList.toggle('active', i === emojiInlineIndex));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (emojiInlineIndex >= 0) {
        e.preventDefault();
        pickInline(emojiInlineIndex);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideInline();
    }
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(hideInline, 150);
  });
})();

connectWs();

// ── Theme switching ──
(function initTheme() {
  const btns = document.querySelectorAll('.theme-btn[data-theme]');
  const saved = localStorage.getItem('openclaw-theme') || 'dark';
  applyTheme(saved);

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      applyTheme(theme);
      localStorage.setItem('openclaw-theme', theme);
    });
  });

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    btns.forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  }
})();
