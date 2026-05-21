import { vi } from 'vitest'

// Minimal Web APIs that extension code expects
if (!globalThis.crypto) {
  // Node 20+ has global crypto; keep a fallback for safety.
  const { webcrypto } = await import('node:crypto')
  globalThis.crypto = webcrypto
}

// Stub btoa/atob for Node.
if (!globalThis.btoa) {
  globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64')
}
if (!globalThis.atob) {
  globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary')
}

// chrome.* mock (very small; tests can override per-suite)
const makeEvent = () => {
  const listeners = new Set()
  return {
    addListener(fn) {
      listeners.add(fn)
    },
    removeListener(fn) {
      listeners.delete(fn)
    },
    hasListener(fn) {
      return listeners.has(fn)
    },
    // helper for tests
    _emit(...args) {
      for (const fn of listeners) fn(...args)
    },
    _clear() {
      listeners.clear()
    },
  }
}

globalThis.chrome = {
  runtime: {
    connect: vi.fn(() => {
      const port = {
        name: 'mock-port',
        onMessage: makeEvent(),
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      }
      return port
    }),
    onMessage: makeEvent(),
    sendMessage: vi.fn(async () => undefined),
    getURL: vi.fn((path) => `chrome-extension://test/${path}`),
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    },
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    },
  },
  tabs: {
    query: vi.fn(async () => []),
    get: vi.fn(async () => ({ id: 1 })),
    remove: vi.fn(async () => undefined),
    onActivated: makeEvent(),
  },
  tabGroups: {
    query: vi.fn(async () => []),
  },
  action: {
    setBadgeText: vi.fn(async () => undefined),
    setBadgeBackgroundColor: vi.fn(async () => undefined),
    setBadgeTextColor: vi.fn(async () => undefined),
  },
  debugger: {
    sendCommand: vi.fn(async () => undefined),
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
  },
  offscreen: {
    createDocument: vi.fn(async () => undefined),
    closeDocument: vi.fn(async () => undefined),
    hasDocument: vi.fn(async () => false),
  },
}
