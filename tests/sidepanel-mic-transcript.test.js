import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// These tests model the mic transcript accumulation logic in sidepanel.js.
// We intentionally keep the logic in-sync with the in-file implementation.

function applyPartial({ livePartial, finalText }, text) {
  livePartial += String(text || '')
  return { livePartial, finalText }
}

function applyFinal({ livePartial, finalText }, text) {
  const segment = String(text || '').trim()
  if (segment) {
    finalText = (finalText ? finalText + ' ' : '') + segment
  }
  livePartial = ''
  return { livePartial, finalText }
}

function renderInputValue({ livePartial, finalText }) {
  if (livePartial) return (finalText ? finalText + ' ' : '') + livePartial
  return finalText
}

describe('sidepanel mic transcript accumulation (modeled)', () => {
  it('single segment: partial -> final sets input to final', () => {
    let s = { livePartial: '', finalText: '' }
    s = applyPartial(s, 'hel')
    expect(renderInputValue(s)).toBe('hel')
    s = applyPartial(s, 'lo')
    expect(renderInputValue(s)).toBe('hello')

    s = applyFinal(s, 'hello')
    expect(s.livePartial).toBe('')
    expect(s.finalText).toBe('hello')
    expect(renderInputValue(s)).toBe('hello')
  })

  it('multiple finals are accumulated with spaces', () => {
    let s = { livePartial: '', finalText: '' }
    s = applyFinal(s, 'first')
    s = applyFinal(s, 'second')
    s = applyFinal(s, 'third')
    expect(s.finalText).toBe('first second third')
  })

  it('partial display includes accumulated finals + current partial', () => {
    let s = { livePartial: '', finalText: '' }
    s = applyFinal(s, 'hello')
    s = applyPartial(s, 'wor')
    expect(renderInputValue(s)).toBe('hello wor')
    s = applyPartial(s, 'ld')
    expect(renderInputValue(s)).toBe('hello world')
  })

  it('final clears livePartial for next segment', () => {
    let s = { livePartial: '', finalText: '' }
    s = applyPartial(s, 'par')
    s = applyPartial(s, 'tial')
    s = applyFinal(s, 'partial')
    expect(s.livePartial).toBe('')

    s = applyPartial(s, 'n')
    expect(renderInputValue(s)).toBe('partial n')
  })

  it('whitespace-only final segment is ignored (does not add extra spaces)', () => {
    let s = { livePartial: '', finalText: 'hello' }
    s = applyFinal(s, '   ')
    expect(s.finalText).toBe('hello')
  })

  it('undefined/null final transcript is ignored', () => {
    let s = { livePartial: '', finalText: 'hello' }
    s = applyFinal(s, undefined)
    s = applyFinal(s, null)
    expect(s.finalText).toBe('hello')
  })

  it('empty partial does not change rendered value if finals exist', () => {
    let s = { livePartial: '', finalText: 'hello' }
    s = applyPartial(s, '')
    expect(renderInputValue(s)).toBe('hello')
  })

  it('reset-on-start clears both livePartial and finalText', () => {
    let s = { livePartial: 'abc', finalText: 'hello there' }
    // sidepanel startRecording() does: livePartial='', finalText='', inputEl.value=''
    s = { livePartial: '', finalText: '' }
    expect(renderInputValue(s)).toBe('')
  })

  it('auto-send should happen on STREAM_ENDED only if finalText has non-whitespace', () => {
    const sendMessage = vi.fn()

    // has text
    let s = { livePartial: '', finalText: 'hi' }
    if (s.finalText.trim()) sendMessage()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    // empty
    sendMessage.mockClear()
    s = { livePartial: '', finalText: '' }
    if (s.finalText.trim()) sendMessage()
    expect(sendMessage).toHaveBeenCalledTimes(0)

    // whitespace
    s = { livePartial: '', finalText: '   ' }
    if (s.finalText.trim()) sendMessage()
    expect(sendMessage).toHaveBeenCalledTimes(0)
  })

  it('STREAM_ENDED resets UI before auto-send (ordering modeled)', () => {
    const resetRecordingUI = vi.fn()
    const sendMessage = vi.fn()

    const s = { finalText: 'hello' }
    resetRecordingUI()
    if (s.finalText.trim()) sendMessage()

    expect(resetRecordingUI).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(resetRecordingUI.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0])
  })
})

describe('sidepanel mic UI state machine (jsdom)', () => {
  let micBtn
  let sendBtn
  let inputEl
  let micIcon
  let recordingIcon
  let spinnerIcon

  function updateRecordingUI(state) {
    // Mirrors sidepanel.js updateRecordingUI
    if (state === 'recording') {
      micIcon.style.display = 'none'
      recordingIcon.style.display = 'block'
      spinnerIcon.style.display = 'none'
      micBtn.classList.add('recording')
      micBtn.classList.remove('processing')
      micBtn.title = 'Stop recording'
      sendBtn.disabled = true
      inputEl.readOnly = true
    } else if (state === 'processing') {
      micIcon.style.display = 'none'
      recordingIcon.style.display = 'none'
      spinnerIcon.style.display = 'block'
      micBtn.classList.remove('recording')
      micBtn.classList.add('processing')
      micBtn.title = 'Transcribing...'
      sendBtn.disabled = true
      inputEl.readOnly = true
    } else {
      micIcon.style.display = 'block'
      recordingIcon.style.display = 'none'
      spinnerIcon.style.display = 'none'
      micBtn.classList.remove('recording', 'processing')
      micBtn.title = 'Voice input'
      sendBtn.disabled = false
      inputEl.readOnly = false
    }
  }

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="micBtn" title="Voice input">
        <span class="mic-icon"></span>
        <span class="recording-icon"></span>
        <span class="spinner-icon"></span>
      </button>
      <button id="sendBtn"></button>
      <textarea id="input"></textarea>
    `

    micBtn = document.getElementById('micBtn')
    sendBtn = document.getElementById('sendBtn')
    inputEl = document.getElementById('input')
    micIcon = micBtn.querySelector('.mic-icon')
    recordingIcon = micBtn.querySelector('.recording-icon')
    spinnerIcon = micBtn.querySelector('.spinner-icon')

    // sensible initial state
    micIcon.style.display = 'block'
    recordingIcon.style.display = 'none'
    spinnerIcon.style.display = 'none'
    sendBtn.disabled = false
    inputEl.readOnly = false
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('idle state shows mic icon, hides recording+spinner, enables send, input not readonly', () => {
    updateRecordingUI('idle')
    expect(micIcon.style.display).toBe('block')
    expect(recordingIcon.style.display).toBe('none')
    expect(spinnerIcon.style.display).toBe('none')
    expect(sendBtn.disabled).toBe(false)
    expect(inputEl.readOnly).toBe(false)
    expect(micBtn.title).toBe('Voice input')
  })

  it('recording state hides mic icon, shows recording icon, disables send, input readonly', () => {
    updateRecordingUI('recording')
    expect(micIcon.style.display).toBe('none')
    expect(recordingIcon.style.display).toBe('block')
    expect(spinnerIcon.style.display).toBe('none')
    expect(sendBtn.disabled).toBe(true)
    expect(inputEl.readOnly).toBe(true)
    expect(micBtn.classList.contains('recording')).toBe(true)
    expect(micBtn.classList.contains('processing')).toBe(false)
    expect(micBtn.title).toBe('Stop recording')
  })

  it('processing state shows spinner, disables send, input readonly', () => {
    updateRecordingUI('processing')
    expect(micIcon.style.display).toBe('none')
    expect(recordingIcon.style.display).toBe('none')
    expect(spinnerIcon.style.display).toBe('block')
    expect(sendBtn.disabled).toBe(true)
    expect(inputEl.readOnly).toBe(true)
    expect(micBtn.classList.contains('recording')).toBe(false)
    expect(micBtn.classList.contains('processing')).toBe(true)
    expect(micBtn.title).toBe('Transcribing...')
  })

  it('idle clears classes recording/processing', () => {
    micBtn.classList.add('recording', 'processing')
    updateRecordingUI('idle')
    expect(micBtn.classList.contains('recording')).toBe(false)
    expect(micBtn.classList.contains('processing')).toBe(false)
  })

  it('resetRecordingUI sets idle and clears isRecording flag (modeled)', () => {
    let isRecording = true
    function resetRecordingUI() {
      isRecording = false
      updateRecordingUI('idle')
    }

    updateRecordingUI('recording')
    resetRecordingUI()

    expect(isRecording).toBe(false)
    expect(sendBtn.disabled).toBe(false)
    expect(inputEl.readOnly).toBe(false)
    expect(micIcon.style.display).toBe('block')
  })

  it('transition recording -> processing -> idle produces consistent icon visibility', () => {
    updateRecordingUI('recording')
    expect(recordingIcon.style.display).toBe('block')
    updateRecordingUI('processing')
    expect(spinnerIcon.style.display).toBe('block')
    updateRecordingUI('idle')
    expect(micIcon.style.display).toBe('block')
    expect(recordingIcon.style.display).toBe('none')
    expect(spinnerIcon.style.display).toBe('none')
  })

  it('recording state sets proper title attr for UX', () => {
    updateRecordingUI('recording')
    expect(micBtn.getAttribute('title')).toBe('Stop recording')
  })

  it('processing state sets proper title attr for UX', () => {
    updateRecordingUI('processing')
    expect(micBtn.getAttribute('title')).toBe('Transcribing...')
  })
})
