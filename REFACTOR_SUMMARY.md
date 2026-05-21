# OpenClaw Browser Extension — Sidebar UI Refactor

**Date:** 2026-05-20  
**Scope:** Simplify sidebar UI, remove Display settings, enhance follow-toggle styling

## Changes Made

### 1. **Removed "Display" Settings Section** ✅
- **File:** `options.html`, `options.js`
- **What:** Removed the entire "Display" card that allowed users to set custom agent name
- **Why:** Agent name is now hardcoded to "OpenClaw" — no need for configuration
- **Impact:** Cleaner settings page, one less thing to configure

### 2. **Bigger Header Avatar** ✅
- **File:** `sidepanel.html`, `sidepanel.css`
- **What:** 
  - Renamed `.header-separator` → `.header-avatar`
  - Increased size from 18px → 36px
  - Added hover effect (scale 1.05, opacity boost)
  - Made it cursor:pointer for future interactions
- **Why:** More prominent agent presence in sidebar
- **Visual:** Avatar is now 2x larger and more engaging

### 3. **Restyled Follow Toggle** ✅
- **File:** `sidepanel.html`, `sidepanel.css`
- **What:**
  - Changed from wide orange slider (44px × 26px) to compact icon button (32px × 32px)
  - Removed "WATCHING" text label completely
  - New style: subtle bordered button with eye icon
  - Icon animates on toggle (rotate + scale transition)
  - Active state: orange background glow + accent border
- **Why:** Cleaner, less visually noisy, matches modern icon-button pattern
- **Before:** `[👁️ ←→ WATCHING]` (orange slider)
- **After:** `[👁️]` (clean icon button, glows orange when active)

### 4. **Hardcoded Display Name** ✅
- **File:** `sidepanel.js`
- **What:**
  - Removed `displayName` from storage reads
  - Agent name is now always "OpenClaw"
  - Removed settings listener for display name changes
- **Why:** Simplification — no user-configurable name needed

## What We Kept

✅ **Tab attach/follow system** — tracks tab titles, URLs, favicons  
✅ **Auto-attach on tab switch** when follow mode is ON  
✅ **Pinned tabs** — stay attached across navigation  
✅ **Tab count display** in header  
✅ **Share Tab button** — manual screenshot + content sharing  
✅ **Tab stats tooltip** — shows open tabs, groups, windows

## What We Did NOT Add

❌ Auto-screenshot on tab attach — **deliberately kept simple**  
- Screenshots only happen when user explicitly clicks "Share Tab" button
- Attached tabs just send title + URL (lightweight, non-invasive)

## Visual Comparison

### Header (Before → After)
```
BEFORE: [👁️ ←→ WATCHING] [tiny avatar 18px] [Tab Stats]
AFTER:  [👁️ icon btn]      [bigger avatar 36px] [Tab Stats]
```

### Follow Toggle States
```
OFF:  [👁️-slash] (muted gray, small border)
ON:   [👁️ open]  (orange glow, accent border, shadow)
```

## Testing Checklist

- [ ] Follow toggle works (attach/detach tabs on click)
- [ ] Avatar displays at 36px (not 18px)
- [ ] Avatar hover effect works
- [ ] Settings page doesn't show Display section
- [ ] Agent name shows as "OpenClaw" in messages
- [ ] Tab attach/pin/detach still works
- [ ] Share Tab button still captures screenshots

## Files Changed

```
options.html   — Removed Display card
options.js     — Removed loadDisplay(), saveDisplay()
sidepanel.html — Removed label text, renamed avatar class
sidepanel.css  — Restyled follow-toggle, enlarged avatar
sidepanel.js   — Hardcoded displayName to 'OpenClaw'
```

## Rollback

If needed:
```bash
cd ~/projects/openclaw-extension
git checkout HEAD~1 -- options.html options.js sidepanel.html sidepanel.css sidepanel.js
```

---

**Result:** Cleaner, simpler UI. Follow toggle is now a subtle icon button instead of a flashy slider. Avatar is bigger and more prominent. One less setting to maintain.
