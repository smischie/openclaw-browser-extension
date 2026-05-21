# Extension Tests

This folder contains unit-ish tests for the OpenClaw MV3 extension.

## Run

```bash
cd ~/projects/openclaw-extension
npm install
npm test
```

## What is covered

- `background-utils.js` pure helpers (backoff, error classification)
- Audio/PCM conversion helpers used by `offscreen.js` streaming
- WebSocket streaming protocol event handling (mocked)
- `/tabs` command parsing and a tiny `chrome.tabs.remove` integration sanity check
- A message-flow simulation (sidepanel → background → offscreen) as a pure router test

## Notes

- These tests **do not** spin up a real extension environment.
- We mock a minimal `chrome.*` API surface in `tests/setup.js`.
- For audio pipeline tests we validate math + encoding, not actual microphone capture.
