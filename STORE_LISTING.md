# Microsoft Edge Add-ons Store Listing

## Short Description (132 characters max)
**Current: 116 characters**

Your personal AI assistant in the sidebar. Chat, manage tabs, voice input. Self-hosted, private, no data collection.

---

## Full Description

**OpenClaw Browser Extension** brings your personal AI assistant directly into your browser sidebar. Chat alongside any webpage, manage your tabs intelligently, and control your browsing with natural language.

### Key Features

- **Sidebar Chat** – Talk to your AI assistant while browsing any site. Get help, ask questions, or bounce ideas around without switching tabs.

- **Tab Management** – Your AI can see and manage your open tabs: close duplicates, group related pages, or find that tab you lost in the chaos.

- **Voice Input** – Use speech-to-text to chat hands-free. Perfect when you're multitasking.

- **Custom New Tab Page** – Start each tab with a clean, focused interface that puts your AI front and center.

- **Self-Hosted & Private** – Connects ONLY to your own OpenClaw gateway (a self-hosted AI server you control). No third-party servers, no analytics, no tracking. Your conversations stay on your infrastructure.

### How It Works

1. Install the extension
2. Point it to your OpenClaw gateway URL (in extension options)
3. Start chatting in the sidebar (click the extension icon)

That's it. The extension is a bridge between your browser and your personal AI server. All the intelligence lives on your side.

### Perfect For

- People who run their own AI infrastructure
- Privacy-conscious users who want AI assistance without cloud dependencies
- Power users who want tab management automation
- Anyone who wants an AI copilot while researching, coding, or writing

### Requirements

- A running OpenClaw gateway (self-hosted open-source AI orchestration server)
- Basic familiarity with configuring server URLs

### Privacy Commitment

- **Zero data collection** – We don't collect, store, or transmit any usage data
- **No external servers** – Connects only to YOUR gateway URL
- **No analytics** – Not even anonymized telemetry
- **Open development** – Built transparently, maintained openly

This is a tool for people who value digital autonomy. If you're running your own AI stack, this extension makes it accessible everywhere you browse.

---

## Privacy Policy

**OpenClaw Browser Extension Privacy Policy**

**Effective Date:** May 20, 2026

### Data Collection

We do not collect, store, transmit, or process any user data. Zero. None.

### What the Extension Does

The extension connects to a server URL that YOU configure in the extension options. This is your personal OpenClaw gateway (a self-hosted AI orchestration server). All communication happens between your browser and your server. We (the extension developers) never see, touch, or have access to any of this.

### What Gets Stored

The extension stores your gateway URL and preferences locally in your browser's storage (using Chrome's `chrome.storage` API). This data never leaves your device.

### Permissions Explained

The extension requests several permissions to function:

- **tabs, tabGroups, activeTab** – To manage and display your open tabs when you ask your AI for help
- **storage** – To save your gateway URL and settings locally
- **webNavigation** – To detect page loads for context awareness
- **sidePanel** – To display the chat sidebar
- **scripting, contextMenus** – For tab management features
- **host_permissions (http://*/*, https://*/*, ws://*)**  – To connect to your self-hosted gateway (which could be on any domain or IP you control)

None of these permissions are used to track you, report analytics, or send data anywhere except to the server URL you explicitly configure.

### Third Parties

There are none. The extension talks to your server. That's the entire network topology.

### Changes to This Policy

If we ever change this policy, we'll update it here and in the extension listing. Given that the whole point is "no data collection," we don't anticipate changes.

### Contact

Questions? Open an issue on the OpenClaw GitHub or contact the extension maintainer through the OpenClaw community channels.

**tl;dr:** This extension is a dumb pipe between your browser and your own server. We don't collect anything because there's nothing to collect.

---

## Categories (for submission)

**Primary:** Productivity  
**Secondary:** Developer Tools

---

## Support & Documentation

- **Extension README:** Included in package (`README.md`)
- **OpenClaw Documentation:** https://github.com/your-username/openclaw (or relevant OpenClaw repo)
- **Support Contact:** (Use your preferred contact method – GitHub issues, email, Discord, etc.)

---

## Screenshots Needed (Not Included)

The Edge Add-ons store requires screenshots. Recommended captures:

1. **Sidebar chat in action** – Show the extension sidebar next to a webpage, with a conversation visible
2. **Tab management** – Demonstrate the tab list/management UI
3. **Options page** – Show the clean settings interface (gateway URL config)
4. **New tab page** – Capture the custom new tab experience
5. **Voice input** – Show the mic/STT interface in use

Take screenshots at 1280x800 or 1920x1080 for best presentation.

---

## Icon Assets

All required icon sizes are present in `icons/` folder:
- ✅ 16x16 (`icon16.png`)
- ✅ 32x32 (`icon32.png`)
- ✅ 48x48 (`icon48.png`)
- ✅ 128x128 (`icon128.png`)

---

## Submission Checklist

- [x] Manifest v3 compliant
- [x] All required icon sizes present
- [x] Description under 132 characters (short version)
- [x] Full description written
- [x] Privacy policy created
- [x] Package excludes dev files (tests, node_modules, deploy scripts)
- [x] Store-ready .zip created
- [ ] Screenshots captured (needs manual work – take 4-5 screenshots as listed above)
- [ ] Promotional images created (optional but recommended – 1400x560 marquee image)
- [ ] Test the .zip in Edge Developer Mode before submitting

---

## Next Steps

1. **Test locally first:**
   ```bash
   # In Edge, go to edge://extensions/
   # Enable "Developer mode"
   # Click "Load unpacked"
   # Select: ~/projects/openclaw-extension/
   # Verify everything works
   ```

2. **Create screenshots** (see "Screenshots Needed" section above)

3. **Submit to Edge Add-ons:**
   - Go to https://partner.microsoft.com/dashboard/microsoftedge/overview
   - Create new submission
   - Upload `~/.openclaw/browser/extension-dist/edge-store-package.zip`
   - Fill in listing details from this document
   - Upload screenshots
   - Submit for review

4. **Review timeline:** Microsoft typically reviews within 2-3 business days. Watch for feedback and be ready to address any policy concerns.

---

**Package ready at:** `~/.openclaw/browser/extension-dist/edge-store-package.zip` (106 KB)
