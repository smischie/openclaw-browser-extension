import { describe, it, expect, vi, beforeEach } from 'vitest'

function makePort() {
  return { postMessage: vi.fn() }
}

// Minimal replication of background.js offscreen → sidepanel forwarding logic.
function forwardOffscreenToSidepanel(sidepanelPortForMic, msg) {
  if (msg.type === 'OFFSCREEN_PARTIAL' || msg.type === 'OFFSCREEN_FINAL' || msg.type === 'OFFSCREEN_STREAM_ENDED') {
    try {
      sidepanelPortForMic?.postMessage({
        type:
          msg.type === 'OFFSCREEN_PARTIAL'
            ? 'PARTIAL_TRANSCRIPT'
            : msg.type === 'OFFSCREEN_FINAL'
              ? 'FINAL_TRANSCRIPT'
              : 'STREAM_ENDED',
        text: msg.text || '',
      })
    } catch (_) {}
  }
}

// Minimal replication of background.js "offscreenCallbacks" request/response handler.
function handleOffscreenResult(offscreenCallbacks, msg) {
  if (msg.type === 'OFFSCREEN_RESULT' || msg.type === 'OFFSCREEN_STREAM_RESULT') {
    const cb = offscreenCallbacks.get(msg.action)
    if (cb) {
      offscreenCallbacks.delete(msg.action)
      cb.resolve(msg)
    }
    return true
  }
  return false
}

describe('message flow / routing', () => {
  let sidepanelPortForMic

  beforeEach(() => {
    sidepanelPortForMic = makePort()
  })

  it('OFFSCREEN_PARTIAL is forwarded as PARTIAL_TRANSCRIPT', () => {
    forwardOffscreenToSidepanel(sidepanelPortForMic, { type: 'OFFSCREEN_PARTIAL', text: 'hel' })
    expect(sidepanelPortForMic.postMessage).toHaveBeenCalledWith({ type: 'PARTIAL_TRANSCRIPT', text: 'hel' })
  })

  it('OFFSCREEN_FINAL is forwarded as FINAL_TRANSCRIPT', () => {
    forwardOffscreenToSidepanel(sidepanelPortForMic, { type: 'OFFSCREEN_FINAL', text: 'hello' })
    expect(sidepanelPortForMic.postMessage).toHaveBeenCalledWith({ type: 'FINAL_TRANSCRIPT', text: 'hello' })
  })

  it('OFFSCREEN_STREAM_ENDED is forwarded as STREAM_ENDED', () => {
    forwardOffscreenToSidepanel(sidepanelPortForMic, { type: 'OFFSCREEN_STREAM_ENDED' })
    expect(sidepanelPortForMic.postMessage).toHaveBeenCalledWith({ type: 'STREAM_ENDED', text: '' })
  })

  it('unrelated message types are ignored', () => {
    forwardOffscreenToSidepanel(sidepanelPortForMic, { type: 'OFFSCREEN_RESULT', ok: true })
    expect(sidepanelPortForMic.postMessage).not.toHaveBeenCalled()
  })

  it('OFFSCREEN_STREAM_RESULT resolves the matching callback and deletes it', async () => {
    const offscreenCallbacks = new Map()
    const resolve = vi.fn()
    const reject = vi.fn()
    offscreenCallbacks.set('start_stream', { resolve, reject })

    const handled = handleOffscreenResult(offscreenCallbacks, {
      type: 'OFFSCREEN_STREAM_RESULT',
      action: 'start_stream',
      ok: true,
    })

    expect(handled).toBe(true)
    expect(resolve).toHaveBeenCalledWith({ type: 'OFFSCREEN_STREAM_RESULT', action: 'start_stream', ok: true })
    expect(offscreenCallbacks.has('start_stream')).toBe(false)
  })

  it('OFFSCREEN_RESULT with unknown action is ignored (no throw)', () => {
    const offscreenCallbacks = new Map()
    const handled = handleOffscreenResult(offscreenCallbacks, {
      type: 'OFFSCREEN_RESULT',
      action: 'does_not_exist',
      ok: true,
    })
    expect(handled).toBe(true)
  })

  it('forwarding tolerates missing sidepanel port (no crash)', () => {
    expect(() => forwardOffscreenToSidepanel(null, { type: 'OFFSCREEN_FINAL', text: 'x' })).not.toThrow()
  })
})
