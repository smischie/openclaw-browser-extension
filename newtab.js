/* newtab.js — OpenClaw New Tab Dashboard */
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'newtab_bookmarks';
const FAVICON_SERVICES = [
  // 1. Chrome's internal favicon cache (best source — has real visited favicons)
  (url) => {
    try {
      return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
    } catch { return ''; }
  },
  // 2. Try the site's own favicon
  (url) => {
    try {
      const origin = new URL(url).origin;
      return `${origin}/favicon.ico`;
    } catch { return ''; }
  },
  // 3. Google favicon service
  (url) => {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch { return ''; }
  },
  // 3. DuckDuckGo fallback
  (url) => {
    try {
      const domain = new URL(url).hostname;
      return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    } catch { return ''; }
  }
];

function getLetterAvatar(title, url) {
  const letter = (title || 'X').charAt(0).toUpperCase();
  const colors = [
    '#FF5A36', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6',
    '#EF4444', '#06B6D4', '#84CC16', '#F97316', '#EC4899'
  ];
  const hash = (url || title || '').split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const color = colors[hash % colors.length];
  
  // SVG data URL for letter avatar
  const svg = `<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg">
    <circle cx="16" cy="16" r="16" fill="${color}"/>
    <text x="16" y="22" font-family="system-ui" font-size="18" font-weight="600" fill="white" text-anchor="middle">${letter}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

// ── Favicon Cache (offline-first) ────────────────────────────────────────────
const FAVICON_CACHE_KEY = 'newtab_favicon_cache';
let faviconCache = {}; // domain → base64 data URL

async function loadFaviconCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(FAVICON_CACHE_KEY, (result) => {
      faviconCache = result[FAVICON_CACHE_KEY] || {};
      resolve();
    });
  });
}

function saveFaviconCache() {
  chrome.storage.local.set({ [FAVICON_CACHE_KEY]: faviconCache });
}

function getCachedFavicon(url) {
  try {
    const domain = new URL(url).hostname;
    return faviconCache[domain] || null;
  } catch { return null; }
}

function cacheFavicon(url, dataUrl) {
  try {
    const domain = new URL(url).hostname;
    faviconCache[domain] = dataUrl;
    saveFaviconCache();
  } catch {}
}

function faviconImgHtml(bmUrl, bmTitle) {
  const cached = getCachedFavicon(bmUrl);
  const src = cached || FAVICON_SERVICES[0](bmUrl);
  const domain = (() => { try { return new URL(bmUrl).hostname; } catch { return ''; } })();
  const letterFallback = getLetterAvatar(bmTitle, bmUrl);
  
  return `<img class="bookmark-favicon" src="${escHtml(src)}" alt="" loading="lazy"
    data-domain="${escHtml(domain)}" data-bm-url="${escHtml(bmUrl)}" data-bm-title="${escHtml(bmTitle)}"
    data-fallback-index="0" data-letter-fallback="${escHtml(letterFallback)}" />`;
}

function handleFaviconError(img) {
  const fallbackIndex = parseInt(img.dataset.fallbackIndex || '0', 10);
  const bmUrl = img.dataset.bmUrl;
  const letterFallback = img.dataset.letterFallback;
  
  if (fallbackIndex < FAVICON_SERVICES.length - 1) {
    // Try next service
    const nextIndex = fallbackIndex + 1;
    img.dataset.fallbackIndex = nextIndex;
    const nextSrc = FAVICON_SERVICES[nextIndex](bmUrl);
    if (nextSrc) {
      img.src = nextSrc;
    } else {
      // Empty URL, skip to next
      img.dataset.fallbackIndex = nextIndex;
      handleFaviconError(img);
    }
  } else {
    // All services failed — use letter avatar
    img.src = letterFallback;
  }
}
// Attach favicon error/load listeners to all bookmark-favicon images via event delegation
document.addEventListener('error', (e) => {
  if (e.target.matches && e.target.matches('img.bookmark-favicon, img.suggest-item-favicon')) {
    handleFaviconError(e.target);
  }
}, true);
document.addEventListener('load', (e) => {
  if (e.target.matches && e.target.matches('img.bookmark-favicon')) {
    cacheFaviconFromImg(e.target);
  }
}, true);

function cacheFaviconFromImg(img) {
  const domain = img.dataset.domain;
  const bmUrl = img.dataset.bmUrl;
  if (!domain || !bmUrl || faviconCache[domain]) return;
  // Skip caching if this is already a letter avatar
  if (img.src && img.src.startsWith('data:image/svg')) return;
  // Check if image is too small (Google returns 16x16 globe for unknown domains)
  if (img.naturalWidth < 4 || img.naturalHeight < 4) {
    handleFaviconError(img);
    return;
  }
  // Draw to canvas to get base64
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 32, 32);
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl && dataUrl.length > 100) { // valid image
      faviconCache[domain] = dataUrl;
      saveFaviconCache();
    }
  } catch {} // CORS may block — that's fine, we'll try again next time
}


// ── Default data ──────────────────────────────────────────────────────────────
const DEFAULT_DATA = {
  categories: [
    {
      id: 'cat_favorites',
      name: 'Favorites',
      icon: '⭐',
      order: 0,
      bookmarks: [
        { id: 'bm_github', title: 'GitHub', url: 'https://github.com', order: 0 },
        { id: 'bm_outlook', title: 'Outlook', url: 'https://outlook.live.com', order: 2 },
        { id: 'bm_youtube', title: 'YouTube', url: 'https://youtube.com', order: 3 },
        { id: 'bm_reddit', title: 'Reddit', url: 'https://reddit.com', order: 4 },
        { id: 'bm_discord', title: 'Discord', url: 'https://discord.com/app', order: 5 }
      ]
    },
    {
      id: 'cat_social',
      name: 'Social',
      icon: '💬',
      order: 1,
      bookmarks: [
        { id: 'bm_twitter', title: 'X (Twitter)', url: 'https://x.com', order: 0 },
        { id: 'bm_linkedin', title: 'LinkedIn', url: 'https://linkedin.com', order: 1 },
        { id: 'bm_whatsapp', title: 'WhatsApp', url: 'https://web.whatsapp.com', order: 2 },
        { id: 'bm_telegram', title: 'Telegram', url: 'https://web.telegram.org', order: 3 }
      ]
    },
    {
      id: 'cat_dev',
      name: 'Development',
      icon: '💻',
      order: 3,
      bookmarks: [
        { id: 'bm_ghrepo', title: 'GitHub Repos', url: 'https://github.com', order: 0 },
        { id: 'bm_openclaw', title: 'OpenClaw Docs', url: 'https://docs.openclaw.ai', order: 1 },
        { id: 'bm_ocdisc', title: 'OpenClaw Discord', url: 'https://discord.com/invite/clawd', order: 2 },
        { id: 'bm_mdn', title: 'MDN Web Docs', url: 'https://developer.mozilla.org', order: 3 },
        { id: 'bm_caniuse', title: 'Can I Use', url: 'https://caniuse.com', order: 4 },
        { id: 'bm_copilot', title: 'GitHub Copilot', url: 'https://github.com/features/copilot', order: 5 }
      ]
    },
    {
      id: 'cat_news',
      name: 'News & Social',
      icon: '📰',
      order: 4,
      bookmarks: [
        { id: 'bm_hn', title: 'Hacker News', url: 'https://news.ycombinator.com', order: 0 },
        { id: 'bm_lobsters', title: 'Lobste.rs', url: 'https://lobste.rs', order: 1 },
        { id: 'bm_x', title: 'X (Twitter)', url: 'https://x.com', order: 2 },
        { id: 'bm_ars', title: 'Ars Technica', url: 'https://arstechnica.com', order: 3 }
      ]
    },
    {
      id: 'cat_tools',
      name: 'Tools',
      icon: '🛠️',
      order: 5,
      bookmarks: [
        { id: 'bm_excalidraw', title: 'Excalidraw', url: 'https://excalidraw.com', order: 0 },
        { id: 'bm_regex', title: 'Regex101', url: 'https://regex101.com', order: 1 },
        { id: 'bm_jsoncrack', title: 'JSON Crack', url: 'https://jsoncrack.com', order: 2 },
        { id: 'bm_speedtest', title: 'Speedtest', url: 'https://speedtest.net', order: 3 },
        { id: 'bm_thingiverse', title: 'Thingiverse', url: 'https://thingiverse.com', order: 4 },
        { id: 'bm_printables', title: 'Printables', url: 'https://printables.com', order: 5 }
      ]
    }
  ]
}

// ── State ─────────────────────────────────────────────────────────────────────
let state = { categories: [] };
let editingBookmark = null;  // { bmId, catId } when editing
let ctxTarget = null;        // { bmId, catId } for context menu

// ── Storage (local + sync mirror for cross-device & safety) ──────────────────
async function loadData() {
  // Try local first (fast, no size limits), fall back to sync (cross-device)
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (localResult) => {
      if (localResult[STORAGE_KEY]) {
        resolve(localResult[STORAGE_KEY]);
      } else {
        // Local empty — check sync (might be a fresh install on another device)
        chrome.storage.sync.get(STORAGE_KEY, (syncResult) => {
          if (syncResult[STORAGE_KEY]) {
            // Restore from sync into local
            chrome.storage.local.set({ [STORAGE_KEY]: syncResult[STORAGE_KEY] });
            resolve(syncResult[STORAGE_KEY]);
          } else {
            resolve(null);
          }
        });
      }
    });
  });
}

async function saveData() {
  // Write to both local (primary) and sync (backup + cross-device)
  await new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
  });
  // Sync mirror — best-effort (may fail if over 100KB quota)
  try {
    const json = JSON.stringify(state);
    if (json.length < 90_000) { // Stay under sync quota (~100KB)
      chrome.storage.sync.set({ [STORAGE_KEY]: state });
    } else {
      console.warn('Bookmarks too large for sync storage, local-only');
    }
  } catch (e) {
    console.warn('Sync storage write failed:', e);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() {
  return crypto.randomUUID();
}

function isUrl(text) {
  return text.includes('.') && !text.includes(' ');
}

function ensureProtocol(url) {
  if (!/^https?:\/\//i.test(url)) return 'https://' + url;
  return url;
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function findCategory(catId) {
  return state.categories.find(c => c.id === catId);
}

function findBookmark(catId, bmId) {
  const cat = findCategory(catId);
  return cat ? cat.bookmarks.find(b => b.id === bmId) : null;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(filter = '') {
  const main = document.getElementById('main-content');
  // Preserve empty-state element
  const emptyState = document.getElementById('empty-state');
  main.innerHTML = '';
  main.appendChild(emptyState);

  const lc = filter.toLowerCase();
  
  // Build category groups with filtered bookmarks
  const categoryGroups = [];
  for (const cat of [...state.categories].sort((a, b) => a.order - b.order)) {
    const matchingBms = cat.bookmarks.filter(bm =>
      !filter ||
      bm.title.toLowerCase().includes(lc) ||
      bm.url.toLowerCase().includes(lc)
    );
    
    if (matchingBms.length === 0) continue;
    
    const bmsToShow = [...matchingBms].sort((a, b) => a.order - b.order);
    categoryGroups.push({ cat, bookmarks: bmsToShow });
  }

  const totalBookmarks = categoryGroups.reduce((sum, g) => sum + g.bookmarks.length, 0);
  
  if (totalBookmarks === 0) {
    document.getElementById('empty-state').style.display = '';
    document.body.classList.remove('search-active');
    return;
  }

  document.getElementById('empty-state').style.display = 'none';

  // Build single horizontal carousel with category groups
  const carousel = document.createElement('div');
  carousel.className = 'bookmarks-carousel';
  
  const scrollContainer = document.createElement('div');
  scrollContainer.className = 'bookmarks-scroll-container';
  
  // Load collapse state
  const collapseState = JSON.parse(localStorage.getItem('newtab_cat_collapse') || '{}');
  
  let visibleIndex = 0;
  
  for (const { cat, bookmarks } of categoryGroups) {
    const isCollapsed = collapseState[cat.id] || false;
    
    // Create category group wrapper
    const group = document.createElement('div');
    group.className = 'category-group';
    group.dataset.catId = cat.id;
    if (isCollapsed) group.classList.add('collapsed');
    
    // Category label (top row)
    const label = document.createElement('div');
    label.className = 'category-label';
    if (isCollapsed) label.classList.add('collapsed');
    label.innerHTML = `<span class="category-label-icon">${cat.icon}</span><span class="category-label-name">${escHtml(cat.name)}</span><span class="category-label-chevron">▾</span><button class="category-add-btn" title="Add bookmark" data-cat-id="${cat.id}">+</button>`;
    
    // Collapse on label click (but not on the + button)
    label.addEventListener('click', (e) => {
      if (e.target.closest('.category-add-btn')) return;
      const collapsed = group.classList.toggle('collapsed');
      label.classList.toggle('collapsed', collapsed);
      
      // Save state
      const state = JSON.parse(localStorage.getItem('newtab_cat_collapse') || '{}');
      state[cat.id] = collapsed;
      localStorage.setItem('newtab_cat_collapse', JSON.stringify(state));
      
      updateScrollFade(carousel);
    });
    
    group.appendChild(label);

    // "+" button opens add-bookmark modal pre-filled with this category
    label.querySelector('.category-add-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openBookmarkModal(null, cat.id);
    });
    
    // Category tiles (bottom row)
    const tiles = document.createElement('div');
    tiles.className = 'category-tiles';
    
    for (const bm of bookmarks) {
      const card = buildCard(bm, cat.id, filter ? ++visibleIndex : null);
      tiles.appendChild(card);
    }
    
    group.appendChild(tiles);
    scrollContainer.appendChild(group);
  }

  // Add "+ New Category" button at the end of the carousel
  const addCatBtn = document.createElement('div');
  addCatBtn.className = 'category-group add-category-group';
  addCatBtn.innerHTML = `<button class="add-category-btn" title="New category">+</button><span class="add-category-label">Category</span>`;
  addCatBtn.addEventListener('click', () => {
    const name = prompt('Category name:');
    if (!name || !name.trim()) return;
    const icon = prompt('Emoji icon (e.g. \ud83d\udcbb):', '\ud83d\udcc1') || '\ud83d\udcc1';
    const newCat = {
      id: 'cat_' + crypto.randomUUID().slice(0, 8),
      name: name.trim(),
      icon: icon,
      order: state.categories.length,
      bookmarks: []
    };
    state.categories.push(newCat);
    saveData().then(() => render());
  });
  scrollContainer.appendChild(addCatBtn);
  
  carousel.appendChild(scrollContainer);
  main.appendChild(carousel);

  // Update scroll fade edges
  updateScrollFade(carousel);
  scrollContainer.addEventListener('scroll', () => updateScrollFade(carousel));

  // Mouse wheel → horizontal scroll
  scrollContainer.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      scrollContainer.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // number badges only when searching
  document.body.classList.toggle('search-active', filter.length > 0);
}

function updateScrollFade(carousel) {
  const container = carousel.querySelector('.bookmarks-scroll-container');
  if (!container) return;
  
  const { scrollLeft, scrollWidth, clientWidth } = container;
  const isScrollable = scrollWidth > clientWidth;
  const canScrollLeft = scrollLeft > 10;
  const canScrollRight = scrollLeft < scrollWidth - clientWidth - 10;
  
  carousel.classList.toggle('scroll-left', isScrollable && canScrollLeft);
  carousel.classList.toggle('scroll-right', isScrollable && canScrollRight);
}

function buildCard(bm, catId, shortcutNum) {
  const card = document.createElement('div');
  card.className = 'bookmark-card';
  card.draggable = true;
  card.dataset.bmId = bm.id;
  card.dataset.catId = catId;

  // Let CSS handle truncation with ellipsis
  const domain = getDomain(bm.url);

  card.innerHTML = `
    ${shortcutNum && shortcutNum <= 9 ? `<span class="bookmark-number">${shortcutNum}</span>` : ''}
    ${faviconImgHtml(bm.url, bm.title)}
    <div class="bookmark-info">
      <span class="bookmark-title" title="${escHtml(bm.title)}">${escHtml(bm.title)}</span>
      <span class="bookmark-url" title="${escHtml(domain)}">${escHtml(domain)}</span>
    </div>
    <div class="card-actions">
      <button class="card-action-btn menu-btn" title="Menu" data-bm-id="${bm.id}" data-cat-id="${catId}">⋯</button>
      <div class="card-dropdown" data-bm-id="${bm.id}" data-cat-id="${catId}">
        <button class="card-dropdown-item rename-item">✏️ Edit</button>
        <button class="card-dropdown-item danger remove-item">🗑️ Remove</button>
      </div>
    </div>
  `;

  // Navigate on click
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-actions')) return;
    window.location.href = bm.url;
  });

  // Middle-click → new tab
  card.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      window.open(bm.url, '_blank');
    }
  });

  // Right-click → context menu
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, bm.id, catId);
  });

  // Three-dot menu button → toggle dropdown
  const menuBtn = card.querySelector('.menu-btn');
  const dropdown = card.querySelector('.card-dropdown');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any other open dropdowns
    document.querySelectorAll('.card-dropdown.visible').forEach(d => {
      if (d !== dropdown) d.classList.remove('visible');
    });
    dropdown.classList.toggle('visible');
  });

  // Rename
  card.querySelector('.rename-item').addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.remove('visible');
    openBookmarkModal(bm.id, catId);
  });

  // Remove
  card.querySelector('.remove-item').addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.remove('visible');
    deleteBookmark(bm.id, catId);
  });

  // ── Drag & Drop ──
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ bmId: bm.id, catId }));
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  });

  return card;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Search + Auto-suggest (Fix 3 & 4) ────────────────────────────────────────
let suggestDebounceTimer = null;
let suggestActiveIndex = -1;
let suggestItems = [];   // [{type:'bookmark'|'suggestion', url, title, query}]

function closeSuggest() {
  const dd = document.getElementById('search-suggest');
  if (dd) dd.style.display = 'none';
  suggestActiveIndex = -1;
  suggestItems = [];
}

function renderSuggestDropdown(bookmarks, webData, karakeepResults, homepageResults) {
  const dd = document.getElementById('search-suggest');
  if (!dd) return;
  dd.innerHTML = '';
  suggestItems = [];
  suggestActiveIndex = -1;

  const webQueries = (webData && webData.queries) || [];
  const webNavs = (webData && webData.navigations) || [];
  const karakeep = karakeepResults || [];
  const homepage = homepageResults || [];

  const hasBookmarks = bookmarks.length > 0;
  const hasSuggestions = webQueries.length > 0 || webNavs.length > 0;
  const hasKarakeep = karakeep.length > 0;
  const hasHomepage = homepage.length > 0;

  if (!hasBookmarks && !hasSuggestions && !hasKarakeep && !hasHomepage) {
    dd.style.display = 'none';
    return;
  }

  function makeItem(icon, faviconSrc, title, subtitle, data) {
    const item = document.createElement('div');
    item.className = 'suggest-item';
    item.dataset.idx = suggestItems.length;
    suggestItems.push(data);

    let iconHtml;
    if (faviconSrc) {
      const letterFallback = getLetterAvatar(title, data.url || '');
      iconHtml = `<img class="suggest-item-favicon" src="${escHtml(faviconSrc)}" alt=""
        data-letter-fallback="${escHtml(letterFallback)}"
        data-fallback-index="99"
        loading="lazy" />`;
    } else {
      iconHtml = `<span class="suggest-item-icon">${icon}</span>`;
    }

    item.innerHTML = `
      ${iconHtml}
      <div class="suggest-item-text">
        <div class="suggest-item-title">${escHtml(title)}</div>
        ${subtitle ? `<div class="suggest-item-url">${escHtml(subtitle)}</div>` : ''}
      </div>
    `;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // don't blur input
      activateSuggestItem(Number(item.dataset.idx));
    });
    return item;
  }

  if (hasBookmarks) {
    const hdr = document.createElement('div');
    hdr.className = 'suggest-section-header';
    hdr.textContent = '📌 Bookmarks';
    dd.appendChild(hdr);
    for (const bm of bookmarks) {
      const favicon = FAVICON_SERVICES[0](bm.url);
      dd.appendChild(makeItem('', favicon, bm.title, getDomain(bm.url),
        { type: 'bookmark', url: bm.url }));
    }
  }

  if (hasBookmarks && hasSuggestions) {
    const div = document.createElement('div');
    div.className = 'suggest-divider';
    dd.appendChild(div);
  }

  if (hasSuggestions) {
    const hdr = document.createElement('div');
    hdr.className = 'suggest-section-header';
    hdr.textContent = '🌐 Suggestions';
    dd.appendChild(hdr);
    for (const s of webQueries) {
      dd.appendChild(makeItem('🔍', '', s, '',
        { type: 'suggestion', query: s }));
    }
    for (const s of webNavs) {
      dd.appendChild(makeItem('🔗', '', getDomain(s), s,
        { type: 'suggestion', query: s }));
    }
  }

  if (hasKarakeep) {
    if (hasBookmarks || hasSuggestions) {
      const div = document.createElement('div');
      div.className = 'suggest-divider';
      dd.appendChild(div);
    }
    const hdr = document.createElement('div');
    hdr.className = 'suggest-section-header';
    hdr.textContent = '📌 Karakeep';
    dd.appendChild(hdr);
    for (const k of karakeep) {
      const favicon = FAVICON_SERVICES[0](k.url);
      dd.appendChild(makeItem('', favicon, k.title || getDomain(k.url), getDomain(k.url),
        { type: 'bookmark', url: k.url }));
    }
  }

  if (hasHomepage) {
    if (hasBookmarks || hasSuggestions || hasKarakeep) {
      const div = document.createElement('div');
      div.className = 'suggest-divider';
      dd.appendChild(div);
    }
    const hdr = document.createElement('div');
    hdr.className = 'suggest-section-header';
    hdr.textContent = '🏠 Services';
    dd.appendChild(hdr);
    for (const s of homepage) {
      const favicon = FAVICON_SERVICES[0](s.url);
      dd.appendChild(makeItem('', favicon, s.name, s.desc || getDomain(s.url),
        { type: 'bookmark', url: s.url }));
    }
  }

  dd.style.display = 'block';
}

function activateSuggestItem(idx) {
  const item = suggestItems[idx];
  if (!item) return;
  closeSuggest();
  const input = document.getElementById('search-input');
  if (item.type === 'bookmark') {
    window.location.href = item.url;
  } else {
    input.value = item.query;
    if (isUrl(item.query)) {
      window.location.href = ensureProtocol(item.query);
    } else {
      window.location.href = 'https://www.bing.com/search?q=' + encodeURIComponent(item.query);
    }
  }
}

function highlightSuggestItem(idx) {
  const dd = document.getElementById('search-suggest');
  if (!dd) return;
  dd.querySelectorAll('.suggest-item').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
  });
}

function getBookmarkSuggestions(query) {
  const lc = query.toLowerCase();
  const results = [];
  for (const cat of state.categories) {
    for (const bm of cat.bookmarks) {
      if (bm.title.toLowerCase().includes(lc) || bm.url.toLowerCase().includes(lc)) {
        results.push(bm);
        if (results.length >= 5) return results;
      }
    }
  }
  return results;
}

async function fetchBingSuggestions(query) {
  try {
    // Ask background script to fetch (no CORS restrictions there)
    const resp = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
      chrome.runtime.sendMessage(
        { type: 'search-suggest', query },
        (result) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
          resolve(result);
        }
      );
    });
    if (resp && (resp.queries || resp.navigations)) return resp;
    if (resp && resp.suggestions) return { queries: resp.suggestions, navigations: [] };
  } catch {
    // Fallback: try direct fetch (may fail due to CORS, but worth a shot)
    try {
      const url = `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(query)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[1])) return { queries: data[1].slice(0, 4), navigations: [] };
    } catch {}
  }
  return { queries: [], navigations: [] };
}

async function fetchKarakeepSuggestions(query) {
  try {
    const resp = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
      chrome.runtime.sendMessage(
        { type: 'karakeep-search', query },
        (result) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
          resolve(result);
        }
      );
    });
    return (resp && resp.results) || [];
  } catch {}
  return [];
}

// ── Homepage services search ─────────────────────────────────────────────────
let homepageServices = [];

async function fetchHomepageServices() {
  try {
    const stored = await chrome.storage.local.get(['homepageUrl']);
    const baseUrl = (stored.homepageUrl || '').replace(/\/$/, '');
    if (!baseUrl) return;
    const res = await fetch(`${baseUrl}/api/services`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (!Array.isArray(data)) return;
    homepageServices = [];
    for (const group of data) {
      for (const svc of (group.services || [])) {
        if (svc.href) {
          homepageServices.push({
            name: svc.name || '',
            desc: svc.description || '',
            url: svc.href,
            group: group.name || ''
          });
        }
      }
    }
  } catch {}
}

function searchHomepageServices(query) {
  if (!homepageServices.length || !query) return [];
  const q = query.toLowerCase();
  return homepageServices.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.desc.toLowerCase().includes(q) ||
    s.group.toLowerCase().includes(q) ||
    s.url.toLowerCase().includes(q)
  ).slice(0, 4);
}

function setupSearch() {
  const input = document.getElementById('search-input');
  const hint = document.getElementById('search-hint');

  input.addEventListener('input', () => {
    const val = input.value.trim();
    render(val);

    clearTimeout(suggestDebounceTimer);
    if (!val) { closeSuggest(); return; }

    suggestDebounceTimer = setTimeout(async () => {
      const query = input.value.trim();
      if (!query) { closeSuggest(); return; }

      const bookmarkMatches = getBookmarkSuggestions(query);
      const homepageMatches = searchHomepageServices(query);

      // Fire web + karakeep suggestions in parallel
      const webPromise = fetchBingSuggestions(query);
      const karakeepPromise = fetchKarakeepSuggestions(query);

      // Show bookmarks + homepage immediately while others load
      renderSuggestDropdown(bookmarkMatches, { queries: [], navigations: [] }, [], homepageMatches);

      const [webSuggestions, karakeepResults] = await Promise.all([webPromise, karakeepPromise]);
      if (input.value.trim() === query) {
        renderSuggestDropdown(bookmarkMatches, webSuggestions, karakeepResults, homepageMatches);
      }
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    const dd = document.getElementById('search-suggest');
    const ddVisible = dd && dd.style.display !== 'none' && suggestItems.length > 0;

    if (ddVisible && e.key === 'ArrowDown') {
      e.preventDefault();
      suggestActiveIndex = Math.min(suggestActiveIndex + 1, suggestItems.length - 1);
      highlightSuggestItem(suggestActiveIndex);
      return;
    }
    if (ddVisible && e.key === 'ArrowUp') {
      e.preventDefault();
      suggestActiveIndex = Math.max(suggestActiveIndex - 1, -1);
      highlightSuggestItem(suggestActiveIndex);
      return;
    }
    if (e.key === 'Escape') {
      if (ddVisible) { closeSuggest(); return; }
      input.value = '';
      render('');
      input.blur();
      return;
    }
    if (e.key === 'Enter') {
      if (ddVisible && suggestActiveIndex >= 0) {
        e.preventDefault();
        activateSuggestItem(suggestActiveIndex);
        return;
      }
      const val = input.value.trim();
      closeSuggest();
      if (!val) return;
      if (isUrl(val)) {
        window.location.href = ensureProtocol(val);
      } else {
        // Search engine from settings (default: browser default via omnibox)
        const searchUrl = state.searchEngine || 'https://www.google.com/search?q=%s';
        window.location.href = searchUrl.replace('%s', encodeURIComponent(val));
      }
    }
  });

  input.addEventListener('focus', () => { hint.style.display = 'none'; });
  input.addEventListener('blur', () => {
    hint.style.display = '';
    // Delay close so mousedown on suggest item fires first
    setTimeout(closeSuggest, 150);
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    const input = document.getElementById('search-input');
    const modalOpen = document.querySelector('.modal-overlay[style*="flex"], .modal-overlay:not([style*="none"])');
    const activeEl = document.activeElement;

    // Focus search: / or Ctrl+K
    if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && activeEl !== input && !isModalOpen()) {
      e.preventDefault();
      input.focus();
      input.select();
      return;
    }

    // Escape: clear search or close modal
    if (e.key === 'Escape') {
      if (isModalOpen()) {
        closeAllModals();
        return;
      }
      if (input.value) {
        input.value = '';
        render('');
        return;
      }
    }

    // Number shortcuts: navigate to Nth visible bookmark
    if (/^[1-9]$/.test(e.key) && activeEl !== input && document.body.classList.contains('search-active')) {
      const idx = parseInt(e.key, 10);
      const badges = document.querySelectorAll('.bookmark-number');
      for (const badge of badges) {
        if (badge.textContent === String(idx)) {
          const card = badge.closest('.bookmark-card');
          if (card) {
            const bmId = card.dataset.bmId;
            const catId = card.dataset.catId;
            const bm = findBookmark(catId, bmId);
            if (bm) window.location.href = bm.url;
          }
          break;
        }
      }
    }
  });
}

function isModalOpen() {
  const modals = document.querySelectorAll('.modal-overlay');
  for (const m of modals) {
    if (m.style.display !== 'none') return true;
  }
  return false;
}

function closeAllModals() {
  document.getElementById('bookmark-modal').style.display = 'none';
  document.getElementById('hamburger-menu').style.display = 'none';
  editingBookmark = null;
}

// ── Add/Edit Bookmark Modal ───────────────────────────────────────────────────
function setupBookmarkModal() {
  const modal = document.getElementById('bookmark-modal');
  const closeBtn = document.getElementById('modal-close');
  const cancelBtn = document.getElementById('modal-cancel');
  const saveBtn = document.getElementById('modal-save');
  const catSelect = document.getElementById('bm-category');
  const newCatInput = document.getElementById('bm-new-category');

  closeBtn.addEventListener('click', closeAllModals);
  cancelBtn.addEventListener('click', closeAllModals);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeAllModals(); });

  catSelect.addEventListener('change', () => {
    newCatInput.style.display = catSelect.value === '__new__' ? '' : 'none';
  });

  saveBtn.addEventListener('click', saveBookmark);

  // Enter key saves the modal
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && modal.style.display !== 'none') {
      e.preventDefault();
      saveBookmark();
    }
  });
}

function openBookmarkModal(bmId, catId) {
  const modal = document.getElementById('bookmark-modal');
  const title = document.getElementById('bm-title');
  const url = document.getElementById('bm-url');
  const catSelect = document.getElementById('bm-category');
  const newCatInput = document.getElementById('bm-new-category');
  const modalTitle = document.getElementById('modal-title');

  // Populate category dropdown
  catSelect.innerHTML = '';
  for (const cat of [...state.categories].sort((a, b) => a.order - b.order)) {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = `${cat.icon} ${cat.name}`;
    catSelect.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New Category…';
  catSelect.appendChild(newOpt);

  newCatInput.style.display = 'none';
  newCatInput.value = '';

  if (bmId && catId) {
    // Editing
    const bm = findBookmark(catId, bmId);
    if (!bm) return;
    modalTitle.textContent = 'Edit Bookmark';
    title.value = bm.title;
    url.value = bm.url;
    catSelect.value = catId;
    editingBookmark = { bmId, catId };
  } else {
    modalTitle.textContent = 'Add Bookmark';
    title.value = '';
    url.value = '';
    if (state.categories.length > 0) catSelect.value = state.categories[0].id;
    editingBookmark = null;
  }

  modal.style.display = 'flex';
  setTimeout(() => title.focus(), 50);
}

async function saveBookmark() {
  const titleVal = document.getElementById('bm-title').value.trim();
  let urlVal = document.getElementById('bm-url').value.trim();
  const catSelect = document.getElementById('bm-category');
  const newCatInput = document.getElementById('bm-new-category');

  if (!titleVal || !urlVal) return;
  urlVal = ensureProtocol(urlVal);

  let catId = catSelect.value;

  if (catId === '__new__') {
    const newName = newCatInput.value.trim();
    if (!newName) { newCatInput.focus(); return; }
    const newCat = {
      id: 'cat_' + uid(),
      name: newName,
      icon: '📁',
      order: state.categories.length,
      bookmarks: []
    };
    state.categories.push(newCat);
    catId = newCat.id;
  }

  const cat = findCategory(catId);
  if (!cat) return;

  if (editingBookmark) {
    // Remove from old category if moved
    if (editingBookmark.catId !== catId) {
      const oldCat = findCategory(editingBookmark.catId);
      if (oldCat) {
        oldCat.bookmarks = oldCat.bookmarks.filter(b => b.id !== editingBookmark.bmId);
      }
      cat.bookmarks.push({
        id: editingBookmark.bmId,
        title: titleVal,
        url: urlVal,
        order: cat.bookmarks.length
      });
    } else {
      const bm = findBookmark(catId, editingBookmark.bmId);
      if (bm) { bm.title = titleVal; bm.url = urlVal; }
    }
  } else {
    cat.bookmarks.push({
      id: 'bm_' + uid(),
      title: titleVal,
      url: urlVal,
      order: cat.bookmarks.length
    });
  }

  await saveData();
  closeAllModals();
  render(document.getElementById('search-input').value.trim());
  renderImportBanner();
}

// ── Delete Bookmark ───────────────────────────────────────────────────────────
async function deleteBookmark(bmId, catId) {
  if (!confirm('Delete this bookmark?')) return;
  const cat = findCategory(catId);
  if (!cat) return;
  cat.bookmarks = cat.bookmarks.filter(b => b.id !== bmId);
  await saveData();
  render(document.getElementById('search-input').value.trim());
  renderImportBanner();
}

// ── Context Menu ──────────────────────────────────────────────────────────────
function showContextMenu(x, y, bmId, catId) {
  const menu = document.getElementById('ctx-menu');
  ctxTarget = { bmId, catId };

  // Position
  menu.style.display = 'block';
  menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + 'px';
}

function setupContextMenu() {
  const menu = document.getElementById('ctx-menu');

  document.addEventListener('click', () => { menu.style.display = 'none'; });
  document.addEventListener('contextmenu', () => { /* handled per-card */ });

  document.getElementById('ctx-edit').addEventListener('click', () => {
    if (ctxTarget) openBookmarkModal(ctxTarget.bmId, ctxTarget.catId);
  });

  document.getElementById('ctx-delete').addEventListener('click', () => {
    if (ctxTarget) deleteBookmark(ctxTarget.bmId, ctxTarget.catId);
  });
}

// ── Gear Modal (Import/Export) ────────────────────────────────────────────────
// ── Hamburger Menu ────────────────────────────────────────────────────────────
function setupHamburgerMenu() {
  const btn = document.getElementById('hamburger-btn');
  const menu = document.getElementById('hamburger-menu');
  const fileInput = document.getElementById('import-file');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.style.display = 'none';
    }
    // Close tile dropdowns on outside click
    if (!e.target.closest('.card-actions')) {
      document.querySelectorAll('.card-dropdown.visible').forEach(d => d.classList.remove('visible'));
    }
  });

  document.getElementById('menu-add-btn').addEventListener('click', () => {
    menu.style.display = 'none';
    openBookmarkModal(null, null);
  });

  document.getElementById('menu-import-pins-btn').addEventListener('click', () => {
    menu.style.display = 'none';
    importPinnedTabs();
  });

  document.getElementById('menu-import-browser-btn').addEventListener('click', () => {
    menu.style.display = 'none';
    importBrowserBookmarks();
  });

  document.getElementById('menu-export-btn').addEventListener('click', () => {
    menu.style.display = 'none';
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'openclaw-bookmarks.json';
    a.click();
  });

  document.getElementById('menu-import-json-btn').addEventListener('click', () => {
    menu.style.display = 'none';
    fileInput.click();
  });

  document.getElementById('menu-clear-favicons-btn').addEventListener('click', () => {
    menu.style.display = 'none';
    faviconCache = {};
    saveFaviconCache();
    render();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed.categories || !Array.isArray(parsed.categories)) {
        alert('Invalid bookmark file format.');
        return;
      }
      if (confirm('Replace ALL bookmarks with the imported data?')) {
        state = parsed;
        await saveData();
        render();
      }
    } catch {
      alert('Failed to parse the JSON file.');
    }
    fileInput.value = '';
  });
}

async function importBrowserBookmarks() {
  try {
    if (!chrome.bookmarks) {
      alert('Bookmarks permission not available.');
      return;
    }
    const tree = await chrome.bookmarks.getTree();
    const folders = [];
    function walk(nodes, depth = 0) {
      for (const node of nodes) {
        if (node.children) {
          if (depth > 0 && node.children.some(c => c.url)) {
            folders.push({ title: node.title || 'Untitled', children: node.children.filter(c => c.url) });
          }
          walk(node.children, depth + 1);
        }
      }
    }
    walk(tree);
    if (folders.length === 0) {
      alert('No bookmark folders found.');
      return;
    }
    // Let user pick which folders to import
    const names = folders.map((f, i) => `${i + 1}. ${f.title} (${f.children.length})`);
    const choice = prompt(`Import which folders? (comma-separated numbers, or "all")\n\n${names.join('\n')}`);
    if (!choice) return;
    const selected = choice.trim().toLowerCase() === 'all'
      ? folders
      : choice.split(',').map(n => folders[parseInt(n.trim()) - 1]).filter(Boolean);
    
    let imported = 0;
    for (const folder of selected) {
      let cat = state.categories.find(c => c.name === folder.title);
      if (!cat) {
        cat = { id: 'cat_' + uid(), name: folder.title, icon: '⭐', order: state.categories.length, bookmarks: [] };
        state.categories.push(cat);
      }
      for (const bm of folder.children) {
        if (!bm.url || cat.bookmarks.some(b => b.url === bm.url)) continue;
        cat.bookmarks.push({ id: 'bm_' + uid(), title: bm.title || 'Untitled', url: bm.url, order: cat.bookmarks.length });
        imported++;
      }
    }
    await saveState();
    renderAll();
    alert(`Imported ${imported} bookmarks from ${selected.length} folder(s).`);
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}

async function importPinnedTabs() {
  try {
    const tabs = await new Promise((resolve) => {
      chrome.tabs.query({ pinned: true }, resolve);
    });

    if (!tabs || tabs.length === 0) {
      alert('No pinned tabs found.');
      return;
    }

    let cat = state.categories.find(c => c.name === '📌 Imported Pins');
    if (!cat) {
      cat = {
        id: 'cat_' + uid(),
        name: '📌 Imported Pins',
        icon: '📌',
        order: state.categories.length,
        bookmarks: []
      };
      state.categories.push(cat);
    }

    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://')) continue;
      const alreadyExists = cat.bookmarks.some(b => b.url === tab.url);
      if (!alreadyExists) {
        cat.bookmarks.push({
          id: 'bm_' + uid(),
          title: tab.title || getDomain(tab.url),
          url: tab.url,
          order: cat.bookmarks.length
        });
      }
    }

    await saveData();
    render(document.getElementById('search-input').value.trim());
    document.getElementById('hamburger-menu').style.display = 'none';
    alert(`Imported ${tabs.length} pinned tab(s).`);
  } catch (err) {
    alert('Failed to query pinned tabs: ' + err.message);
  }
}

// ── Widget Constants ──────────────────────────────────────────────────────────
const WIDGETS_KEY = 'newtab_widgets_data';
const DASHBOARD_COLLAPSED_KEY = 'newtab_dashboard_collapsed';

const DEMO_WIDGETS_DATA = {
  lastUpdated: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
  quickGlance: {
    weather: { temp: 72, unit: 'F', condition: 'Partly Cloudy', icon: '⛅' },
    wan: { latency: 14, status: 'online' },
    alarm: { state: 'armed_home', display: 'Armed Home' },
    pools: { total: 4, online: 4, status: 'ok' }
  },
  services: [
    {
      id: 'router', name: 'Router', icon: '📶',
      url: '', status: 'online', group: 'Network',
      metrics: [
        { label: 'WAN', value: '14ms' },
        { label: 'Clients', value: '24 devices' },
        { label: 'Down/Up', value: '450/35 Mbps' }
      ]
    },
    {
      id: 'adblock', name: 'DNS Filter', icon: '🛡️',
      url: '', status: 'online', group: 'Network',
      metrics: [
        { label: 'Queries', value: '45,231' },
        { label: 'Blocked', value: '12% (5,428)' },
        { label: 'DNS', value: '2 servers' }
      ]
    },
    {
      id: 'nas', name: 'NAS', icon: '💾',
      url: '', status: 'online', group: 'Storage',
      metrics: [
        { label: 'CPU', value: '12%' },
        { label: 'RAM', value: '45/110 GB' },
        { label: 'Pools', value: '4/4 Online' },
        { label: 'Alerts', value: '0' }
      ]
    },
    {
      id: 'homeassistant', name: 'Home Assistant', icon: '🏠',
      url: '', status: 'online', group: 'Smart Home',
      metrics: [
        { label: 'Alarm', value: 'Armed Home' },
        { label: 'Temp', value: '72°F' },
        { label: 'Lights', value: '2 on' }
      ]
    },
    {
      id: 'docker', name: 'Docker', icon: '🐳',
      url: '', status: 'online', group: 'Services',
      metrics: [
        { label: 'Running', value: '12 containers' },
        { label: 'Stopped', value: '2' }
      ]
    },
    {
      id: 'openclaw', name: 'OpenClaw', icon: '🥫',
      url: '', status: 'online', group: 'Services',
      metrics: [
        { label: 'Uptime', value: '4d 12h' },
        { label: 'Model', value: 'claude-opus-4.6' },
        { label: 'Sessions', value: '3 active' }
      ]
    }
  ]
};

// ── Widget State ──────────────────────────────────────────────────────────────
let widgetsData = null;
let clockInterval = null;

// ── Widget: Load Data ─────────────────────────────────────────────────────────
async function loadWidgetsData() {
  return new Promise((resolve) => {
    chrome.storage.local.get([WIDGETS_KEY, DASHBOARD_COLLAPSED_KEY], (result) => {
      resolve({
        data: result[WIDGETS_KEY] || null,
        collapsed: result[DASHBOARD_COLLAPSED_KEY] || false
      });
    });
  });
}

async function saveDashboardCollapsed(collapsed) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [DASHBOARD_COLLAPSED_KEY]: collapsed }, resolve);
  });
}

// ── Widget: Render Quick Glance ───────────────────────────────────────────────
function renderQuickGlance(qg) {
  if (!qg) return;
  if (!document.getElementById('weather-icon')) return; // Homepage iframe replaces widgets

  if (qg.weather) {
    document.getElementById('weather-icon').textContent = qg.weather.icon || '🌡️';
    document.getElementById('weather-text').textContent = `${qg.weather.temp}°${qg.weather.unit}`;
    document.getElementById('weather-cond').textContent = qg.weather.condition || 'Weather';
  }

  if (qg.wan) {
    const wanEl = document.getElementById('wan-text');
    wanEl.textContent = qg.wan.status === 'online' ? `${qg.wan.latency}ms` : 'Offline';
  }

  if (qg.alarm) {
    document.getElementById('alarm-text').textContent = qg.alarm.display || '--';
  }

  if (qg.pools) {
    const poolsEl = document.getElementById('pools-text');
    if (qg.pools.status === 'ok') {
      poolsEl.textContent = `${qg.pools.online}/${qg.pools.total} OK`;
    } else {
      poolsEl.textContent = `${qg.pools.online}/${qg.pools.total}`;
    }
  }
}

// ── Widget: Live Clock ────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    const timeEl = document.getElementById('clock-time');
    if (!timeEl) return;
    const dateEl = document.getElementById('clock-date');
    if (!timeEl) return;

    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    timeEl.textContent = `${hh}:${mm}:${ss}`;

    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dateEl.textContent = `${days[now.getDay()]} ${months[now.getMonth()]} ${now.getDate()}`;
  }
  tick();
  clockInterval = setInterval(tick, 1000);
}

// ── Widget: Render Service Cards (grouped) ────────────────────────────────────
const SERVICE_GROUPS = [
  { name: 'Network',    icon: '📶' },
  { name: 'Storage',    icon: '💾' },
  { name: 'Smart Home', icon: '🏠' },
  { name: 'Services',   icon: '⚙️' },
];

function renderServices(services) {
  const grid = document.getElementById('services-grid');
  if (!grid || !services) return;
  grid.innerHTML = '';

  const statusLabels = { online: 'Online', warning: 'Degraded', error: 'Offline', unknown: 'Unknown' };

  const grouped = {};
  const ungrouped = [];
  for (const svc of services) {
    if (svc.group) {
      if (!grouped[svc.group]) grouped[svc.group] = [];
      grouped[svc.group].push(svc);
    } else {
      ungrouped.push(svc);
    }
  }

  const orderedGroups = SERVICE_GROUPS.map(g => g.name).filter(n => grouped[n]);
  for (const key of Object.keys(grouped)) {
    if (!orderedGroups.includes(key)) orderedGroups.push(key);
  }

  let cardIdx = 0;

  function buildSvcCard(svc, idx) {
    const card = document.createElement('div');
    card.className = 'service-card';
    card.style.animationDelay = `${0.04 + idx * 0.05}s`;
    card.title = `Open ${escHtml(svc.name)}`;
    const statusClass = ['online','warning','error','unknown'].includes(svc.status) ? svc.status : 'unknown';
    const statusLabel = statusLabels[statusClass] || 'Unknown';
    const metricsHtml = (svc.metrics || []).map(m => `
      <div class="metric-item">
        <span class="metric-label">${escHtml(m.label)}</span>
        <span class="metric-value">${escHtml(m.value)}</span>
      </div>
    `).join('');
    card.innerHTML = `
      <div class="service-card-header">
        <span class="service-icon">${svc.icon}</span>
        <div class="service-name-group">
          <div class="service-name">${escHtml(svc.name)}</div>
          <div class="service-status-label">${escHtml(statusLabel)}</div>
        </div>
        <span class="status-dot ${statusClass}"></span>
      </div>
      <div class="service-metrics">${metricsHtml}</div>
    `;
    card.addEventListener('click', () => { window.open(svc.url, '_blank'); });
    return card;
  }

  for (const groupName of orderedGroups) {
    const groupMeta = SERVICE_GROUPS.find(g => g.name === groupName) || { icon: '⭐' };
    const groupServices = grouped[groupName];

    const groupEl = document.createElement('div');
    groupEl.className = 'service-group';

    const header = document.createElement('div');
    header.className = 'service-group-header';
    header.textContent = `${groupMeta.icon} ${groupName}`;
    groupEl.appendChild(header);

    const cards = document.createElement('div');
    cards.className = 'service-group-cards';
    for (const svc of groupServices) {
      cards.appendChild(buildSvcCard(svc, cardIdx++));
    }
    groupEl.appendChild(cards);
    grid.appendChild(groupEl);
  }

  for (const svc of ungrouped) {
    grid.appendChild(buildSvcCard(svc, cardIdx++));
  }
}
// ── Widget: Last Updated indicator ───────────────────────────────────────────
function renderLastUpdated(lastUpdated) {
  const el = document.getElementById('dashboard-updated');
  if (!el || !lastUpdated) return;
  const diff = Math.round((Date.now() - new Date(lastUpdated).getTime()) / 60000);
  if (diff < 1) {
    el.textContent = 'Updated just now';
  } else if (diff === 1) {
    el.textContent = 'Updated 1 min ago';
  } else if (diff < 60) {
    el.textContent = `Updated ${diff} min ago`;
  } else {
    const h = Math.round(diff / 60);
    el.textContent = `Updated ${h}h ago`;
  }
}

// ── Widget: Toggle ────────────────────────────────────────────────────────────
function setupDashboardToggle(initialCollapsed) {
  const wrapper = document.getElementById('dashboard-wrapper');
  const btn = document.getElementById('dashboard-toggle');
  if (!wrapper || !btn) return;

  if (initialCollapsed) wrapper.classList.add('collapsed');

  btn.addEventListener('click', async () => {
    const isCollapsed = wrapper.classList.toggle('collapsed');
    await saveDashboardCollapsed(isCollapsed);
  });
}

// ── Widget: Init ──────────────────────────────────────────────────────────────
async function initWidgets() {
  const { data, collapsed } = await loadWidgetsData();
  widgetsData = data || DEMO_WIDGETS_DATA;

  startClock();
  renderQuickGlance(widgetsData.quickGlance);
  renderServices(widgetsData.services);
  renderLastUpdated(widgetsData.lastUpdated);
  setupDashboardToggle(collapsed);
}


// ── Import Pinned Tabs Banner (Fix 2) ─────────────────────────────────────────
function hasUserBookmarks() {
  const defaultBmIds = new Set(
    DEFAULT_DATA.categories.flatMap(c => c.bookmarks.map(b => b.id))
  );
  for (const cat of state.categories) {
    for (const bm of cat.bookmarks) {
      if (!defaultBmIds.has(bm.id)) return true;
    }
  }
  // Also treat non-empty Favorites as "user has bookmarks"
  const favCat = state.categories.find(c => c.id === 'cat_favorites');
  return favCat ? favCat.bookmarks.length > 0 : false;
}

function renderImportBanner() {
  const main = document.getElementById('main-content');
  let banner = document.getElementById('import-pins-banner');
  const showBanner = !hasUserBookmarks();
  if (showBanner && !banner) {
    banner = document.createElement('div');
    banner.id = 'import-pins-banner';
    banner.innerHTML = `
      <span class="import-banner-icon">📌</span>
      <div class="import-banner-text">
        <span class="import-banner-title">Import your pinned tabs</span>
        <span class="import-banner-sub">Bring your browser pins in as bookmarks — one click</span>
      </div>
    `;
    banner.addEventListener('click', async () => {
      await importPinnedTabs();
      renderImportBanner();
    });
    main.insertBefore(banner, main.firstChild);
  } else if (!showBanner && banner) {
    banner.remove();
  }
}


// ── Drag & Drop (reorder within single carousel) ─────────────────────────
function setupDragDrop() {
  const main = document.getElementById('main-content');

  main.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = e.target.closest('.bookmark-card');
    
    // Remove old indicators
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    
    if (card && !card.classList.contains('dragging')) {
      const rect = card.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        card.classList.add('drag-over');
        card.dataset.dropPos = 'before';
      } else {
        card.classList.add('drag-over');
        card.dataset.dropPos = 'after';
      }
    }
  });

  main.addEventListener('dragleave', (e) => {
    const card = e.target.closest('.bookmark-card');
    if (card) card.classList.remove('drag-over');
  });

  main.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

    let data;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    const { bmId, catId: srcCatId } = data;

    const targetCard = e.target.closest('.bookmark-card');
    if (!targetCard) return; // dropped in empty space — ignore

    const destCatId = targetCard.dataset.catId;
    const destBmId = targetCard.dataset.bmId;

    const srcCat = state.categories.find(c => c.id === srcCatId);
    const destCat = state.categories.find(c => c.id === destCatId);
    if (!srcCat || !destCat) return;

    // Remove from source
    const bmIndex = srcCat.bookmarks.findIndex(b => b.id === bmId);
    if (bmIndex === -1) return;
    const [bm] = srcCat.bookmarks.splice(bmIndex, 1);

    // Find insert position
    const destIdx = destCat.bookmarks.findIndex(b => b.id === destBmId);
    if (destIdx === -1) return;
    
    const rect = targetCard.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const insertIndex = e.clientX < midX ? destIdx : destIdx + 1;

    // Insert at position
    destCat.bookmarks.splice(insertIndex, 0, bm);

    // Update order fields
    srcCat.bookmarks.forEach((b, i) => { b.order = i; });
    destCat.bookmarks.forEach((b, i) => { b.order = i; });

    await saveData();
    render();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const saved = await loadData();
  state = saved || JSON.parse(JSON.stringify(DEFAULT_DATA));

  await initWidgets();
  render();
  renderImportBanner();
  setupSearch();
  fetchHomepageServices();
  setupKeyboard();
  setupBookmarkModal();
  setupContextMenu();
  await loadFaviconCache();
  setupHamburgerMenu();
  setupDragDrop();

  // Auto-focus search
  document.getElementById('search-input').focus();

  // Sidebar toggle button
  // Homepage iframe graceful failure
  const iframe = document.getElementById('homepage-iframe');
  const offlineBanner = document.getElementById('offline-banner');
  // Set iframe src from stored homepageUrl
  const hpStored = await chrome.storage.local.get(['homepageUrl']);
  if (iframe && hpStored.homepageUrl) {
    iframe.src = hpStored.homepageUrl;
  } else if (iframe) {
    iframe.style.display = 'none';
  }
  if (iframe && offlineBanner) {
    let loaded = false;
    iframe.addEventListener('load', () => { loaded = true; });
    iframe.addEventListener('error', () => {
      iframe.style.display = 'none';
      offlineBanner.style.display = '';
    });
    // Timeout fallback — if iframe hasn't loaded in 8s, show offline banner
    setTimeout(() => {
      if (!loaded) {
        try {
          // Check if iframe actually has content (cross-origin may throw)
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc || !doc.body || doc.body.innerHTML === '') {
            iframe.style.display = 'none';
            offlineBanner.style.display = '';
          }
        } catch {
          // Cross-origin — can't check, but if load event didn't fire, assume OK
          // (sandboxed iframes may not fire load reliably)
        }
      }
    }, 8000);
  }
}

document.addEventListener('DOMContentLoaded', init);
