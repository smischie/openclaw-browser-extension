# OpenClaw Browser Extension

A Chrome/Edge extension that provides:

1. **Sidebar Chat** — Side panel for chatting with your OpenClaw AI assistant alongside any webpage
2. **Tab Context** — Share current tab info (title, URL, page content) with the assistant
3. **File Attachments** — Drag-drop, paste, or pick files to send with messages
4. **Voice Input** — Speech-to-text via Whisper for hands-free messaging
5. **New Tab Dashboard** — Optional custom new tab page with bookmarks (toggleable in settings)
6. **Tab Manager** — Query, close, and deduplicate browser tabs via the assistant

## Setup

1. Install the extension (sideload as unpacked or from CRX)
2. Open extension settings (right-click icon → Options)
3. Set your **Gateway WebSocket URL** (e.g., `wss://your-gateway.example.com` or `ws://localhost:18789`)
4. Set your **Gateway Token** (must match `gateway.auth.token` in your OpenClaw config)
5. Click the toolbar icon to open the sidebar and start chatting

## Features

### Sidebar Chat
- Real-time WebSocket connection to your OpenClaw gateway
- Streaming responses with typing indicators
- Message history (loads last 1000 messages)
- Custom avatars and themes (dark/light/system)
- Code block syntax highlighting with copy buttons
- Download chat as text file

### Tab Context (Lightweight)
- Add tabs as context using the follow mode or manual attach
- Snapshot feature extracts page content via `chrome.scripting` API
- **No CDP/debugger connection** — no "started debugging" banner
- Context tabs auto-update when navigating

### Voice Input
- Press 🎤 or Enter on empty input to start recording
- Chunked transcription with live preview
- Say "over" to auto-send, "cancel" to abort
- Configurable STT endpoint and model

### New Tab Dashboard (Optional)
- Bookmark categories with drag-and-drop
- Bing search suggestions
- Karakeep bookmark search integration
- Homepage service search
- Can be disabled in settings

## Permissions

- `tabs` / `tabGroups` — Tab context and management
- `activeTab` / `scripting` — Page content extraction for snapshots
- `storage` — Settings and bookmark persistence
- `sidePanel` — Sidebar chat UI
- `contextMenus` — "Send to OpenClaw" right-click menu
- `offscreen` — Audio recording for voice input
- `webNavigation` — Favicon caching for NTP
- `declarativeNetRequest` — Origin header for WebSocket connections
- `favicon` — Tab favicons in context panel

## Development

```bash
# Run tests
npm test

# Load as unpacked extension
# Go to chrome://extensions → Developer mode → Load unpacked → select this folder
```

## Version History

- **v1.0.0** — Publish-ready release: removed CDP/relay, configurable display name, optional NTP, clean settings
- **v0.17.x** — New Tab Dashboard, voice triggers, STT settings
- **v0.16.x** — Voice input via chunked HTTP transcription
- **v0.15.0** — Voice input initial
- **v0.14.0** — Context menu, MEDIA image rendering
- **v0.11.0** — File attachments

## License

Private — for personal use with OpenClaw.
