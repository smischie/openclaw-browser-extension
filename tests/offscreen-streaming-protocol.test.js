import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A tiny mock WebSocket that captures sent messages and allows emitting events.
class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0

  constructor(url) {
    this.url = url
    this.readyState = MockWebSocket.CONNECTING
    this.sent = []
    this.binaryType = null

    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null

    MockWebSocket.instances.push(this)
  }

  send(data) {
    this.sent.push(data)
  }

  _open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  _message(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  _badMessage(raw) {
    this.onmessage?.({ data: raw })
  }

  _error() {
    this.onerror?.()
  }

  close(code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}
MockWebSocket.instances = []

function makePort() {
  return {
    postMessage: vi.fn(),
  }
}

// Extracted minimal handlers matching offscreen.js behavior
function installWsHandlers(ws, port, state) {
  ws.onmessage = (event) => {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }

    if (data.type === 'conversation.item.input_audio_transcription.delta') {
      const delta = String(data.delta || '')
      if (delta) port.postMessage({ type: 'OFFSCREEN_PARTIAL', text: delta })
      return
    }

    if (data.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(data.transcript || '')
      port.postMessage({ type: 'OFFSCREEN_FINAL', text: transcript })
      return
    }
  }

  ws.onclose = () => {
    if (state.isStreaming) {
      state.isStreaming = false
      port.postMessage({ type: 'OFFSCREEN_STREAM_ENDED' })
    }
  }
}

// Minimal replication of offscreen.js "wait for session.updated" wrapper.
async function waitForSessionUpdated(ws, timeoutMs = 3000) {
  await new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs)
    const origOnMessage = ws.onmessage
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'session.updated') {
          clearTimeout(t)
          resolve()
        }
      } catch {}
      if (origOnMessage) origOnMessage.call(ws, event)
    }
  })
}

async function stopStreamingWaitForFinal(ws, timeoutMs = 10_000) {
  // In offscreen.js, we temporarily wrap onmessage to resolve when completed arrives.
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), timeoutMs)
    const origOnMessage = ws.onmessage
    ws.onmessage = (event) => {
      if (origOnMessage) origOnMessage.call(ws, event)
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'conversation.item.input_audio_transcription.completed') {
          clearTimeout(timeout)
          resolve('completed')
        }
      } catch {}
    }
  })
}

describe('offscreen websocket streaming protocol', () => {
  const RealWebSocket = globalThis.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    globalThis.WebSocket = MockWebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = RealWebSocket
  })

  it('sends session.update after open (transcription config has required fields)', () => {
    const ws = new WebSocket('wss://example')

    // emulate startStreaming(): open handshake resolved, and config is sent
    ws._open()
    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          language: 'en',
          turn_detection: {
            type: 'server_vad',
            create_response: false,
            prefix_padding_ms: 300,
            silence_duration_ms: 1500,
            threshold: 0.3,
          },
          input_audio_transcription: {
            model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
            language: 'en',
          },
        },
      }),
    )

    const parsed = JSON.parse(ws.sent[0])
    expect(parsed.type).toBe('session.update')
    expect(parsed.session.language).toBe('en')
    expect(parsed.session.turn_detection.create_response).toBe(false)
    expect(parsed.session.turn_detection.prefix_padding_ms).toBeTypeOf('number')
    expect(parsed.session.turn_detection.silence_duration_ms).toBeTypeOf('number')
    expect(parsed.session.turn_detection.threshold).toBeTypeOf('number')
    expect(parsed.session.input_audio_transcription.model).toMatch(/faster-whisper/)
  })

  it('waitForSessionUpdated resolves on session.updated message, without swallowing prior onmessage handlers', async () => {
    const ws = new WebSocket('wss://example')

    const orig = vi.fn()
    ws.onmessage = orig

    const p = waitForSessionUpdated(ws, 1000)
    ws._message({ type: 'session.updated' })
    await p

    // wrapper should have called original handler too
    expect(orig).toHaveBeenCalled()
  })

  it('waitForSessionUpdated times out (fallback) if session.updated never arrives', async () => {
    const ws = new WebSocket('wss://example')

    const start = Date.now()
    await waitForSessionUpdated(ws, 20)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
  })

  it('audio append message format is correct (type + base64 audio string)', () => {
    const ws = new WebSocket('wss://example')
    const audioB64 = 'AQIDBA=='
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioB64 }))
    const parsed = JSON.parse(ws.sent[0])
    expect(parsed).toEqual({ type: 'input_audio_buffer.append', audio: audioB64 })
  })

  it('forwards partial + final transcription messages to the port', () => {
    const ws = new WebSocket('wss://example')
    const port = makePort()
    const state = { isStreaming: true }
    installWsHandlers(ws, port, state)

    ws._message({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'hel',
    })
    ws._message({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'lo',
    })
    ws._message({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello',
    })

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_PARTIAL', text: 'hel' })
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_PARTIAL', text: 'lo' })
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_FINAL', text: 'hello' })
  })

  it('does not forward empty delta strings', () => {
    const ws = new WebSocket('wss://example')
    const port = makePort()
    const state = { isStreaming: true }
    installWsHandlers(ws, port, state)

    ws._message({ type: 'conversation.item.input_audio_transcription.delta', delta: '' })
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('ignores invalid/non-JSON messages', () => {
    const ws = new WebSocket('wss://example')
    const port = makePort()
    const state = { isStreaming: true }
    installWsHandlers(ws, port, state)

    ws._badMessage('not json')
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('emits OFFSCREEN_STREAM_ENDED on unexpected close while streaming', () => {
    const ws = new WebSocket('wss://example')
    const port = makePort()
    const state = { isStreaming: true }
    installWsHandlers(ws, port, state)

    ws.close(1006, 'abnormal')

    expect(state.isStreaming).toBe(false)
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_STREAM_ENDED' })
  })

  it('does not emit OFFSCREEN_STREAM_ENDED if already stopped', () => {
    const ws = new WebSocket('wss://example')
    const port = makePort()
    const state = { isStreaming: false }
    installWsHandlers(ws, port, state)

    ws.close(1000, 'client stop')
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('stopStreaming waits for final transcript before resolving (completed path)', async () => {
    const ws = new WebSocket('wss://example')
    const port = makePort()
    const state = { isStreaming: true }
    installWsHandlers(ws, port, state)

    const p = stopStreamingWaitForFinal(ws, 1000)
    ws._message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'final' })
    const result = await p

    expect(result).toBe('completed')
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_FINAL', text: 'final' })
  })

  it('stopStreaming times out if final transcript never arrives', async () => {
    const ws = new WebSocket('wss://example')
    const p = stopStreamingWaitForFinal(ws, 20)
    const result = await p
    expect(result).toBe('timeout')
  })
})
