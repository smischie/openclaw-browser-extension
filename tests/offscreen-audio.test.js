import { describe, it, expect } from 'vitest'

// Copied from offscreen.js (kept in sync intentionally)
function downsampleFloat32(input, inSampleRate, outSampleRate) {
  if (outSampleRate === inSampleRate) return input
  if (outSampleRate > inSampleRate) throw new Error('Downsampling rate must be <= input rate')

  const ratio = inSampleRate / outSampleRate
  const newLength = Math.round(input.length / ratio)
  const result = new Float32Array(newLength)

  let offsetResult = 0
  let offsetBuffer = 0
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio)
    // Average the samples in range (cheap low-pass)
    let accum = 0
    let count = 0
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i]
      count++
    }
    result[offsetResult] = count ? accum / count : 0
    offsetResult++
    offsetBuffer = nextOffsetBuffer
  }
  return result
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i]
    s = Math.max(-1, Math.min(1, s))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function pcm16ToBase64(pcm16) {
  const bytes = new Uint8Array(pcm16.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

describe('offscreen audio utils', () => {
  it('downsampleFloat32 returns same reference when rates match', () => {
    const input = new Float32Array([0, 1, 2])
    const out = downsampleFloat32(input, 16000, 16000)
    expect(out).toBe(input)
  })

  it('downsampleFloat32 downsamples by averaging (48k -> 16k gives 1/3 length)', () => {
    // 48k -> 16k ratio 3
    const input = new Float32Array([1, 2, 3, 4, 5, 6])
    const out = downsampleFloat32(input, 48000, 16000)
    // newLength round(6/3)=2
    expect(out.length).toBe(2)
    // buckets [1,2,3] and [4,5,6]
    expect(out[0]).toBeCloseTo(2)
    expect(out[1]).toBeCloseTo(5)
  })

  it('downsampleFloat32 downsamples (44.1k -> 16k) and matches expected rounded output length', () => {
    // ratio 44100/16000 = 2.75625. length=441 -> newLength=round(160)=160
    const input = new Float32Array(441).fill(1)
    const out = downsampleFloat32(input, 44100, 16000)
    expect(out.length).toBe(160)
    // input all 1s -> output all ~1s
    expect(out[0]).toBeCloseTo(1)
    expect(out[out.length - 1]).toBeCloseTo(1)
  })

  it('downsampleFloat32 handles empty input', () => {
    const input = new Float32Array([])
    const out = downsampleFloat32(input, 48000, 16000)
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.length).toBe(0)
  })

  it('downsampleFloat32 handles single sample', () => {
    const input = new Float32Array([0.25])
    const out = downsampleFloat32(input, 48000, 16000)
    // newLength round(1/3)=0
    expect(out.length).toBe(0)
  })

  it('downsampleFloat32 handles very short buffers without throwing', () => {
    const input = new Float32Array([1, 0, -1, 0])
    const out = downsampleFloat32(input, 48000, 16000)
    expect(out.length).toBe(1)
    expect(out[0]).toBeCloseTo((1 + 0 + -1) / 3)
  })

  it('downsampleFloat32 throws if asked to upsample', () => {
    expect(() => downsampleFloat32(new Float32Array([0]), 16000, 48000)).toThrow(
      /Downsampling rate must be <= input rate/,
    )
  })

  it('floatTo16BitPCM clamps to [-1,1] and maps endpoints', () => {
    const input = new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2])
    const out = floatTo16BitPCM(input)
    expect(out).toBeInstanceOf(Int16Array)
    expect(out[0]).toBe(-32768)
    expect(out[1]).toBe(-32768)
    expect(out[3]).toBe(0)
    expect(out[5]).toBe(32767)
    expect(out[6]).toBe(32767)
  })

  it('floatTo16BitPCM maps a couple midpoints with expected sign handling', () => {
    const input = new Float32Array([-0.25, 0.25])
    const out = floatTo16BitPCM(input)
    // Int16Array stores integers; the impl truncates toward 0 via typed array conversion
    expect(out[0]).toBe(-8192)
    expect(out[1]).toBe(8191)
  })

  it('pcm16ToBase64 encodes little-endian bytes that roundtrip via atob', () => {
    const pcm = new Int16Array([0x1234, -1])
    const b64 = pcm16ToBase64(pcm)
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    // Int16Array uses platform endianness; in JS typed arrays are little-endian
    expect(bytes[0]).toBe(0x34)
    expect(bytes[1]).toBe(0x12)
    expect(bytes[2]).toBe(0xff)
    expect(bytes[3]).toBe(0xff)
  })

  it('full audio chunk JSON message matches input_audio_buffer.append schema', () => {
    const down = new Float32Array([0, 1, -1])
    const pcm16 = floatTo16BitPCM(down)
    const audio = pcm16ToBase64(pcm16)

    const msg = { type: 'input_audio_buffer.append', audio }
    expect(msg.type).toBe('input_audio_buffer.append')
    expect(typeof msg.audio).toBe('string')
    // base64 is padded and only base64 chars
    expect(msg.audio).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })
})
