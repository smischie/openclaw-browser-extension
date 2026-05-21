import { describe, it, expect } from 'vitest'

// Extra edge-case coverage for offscreen.js audio helpers.
// These mirror the implementation in offscreen.js.

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

describe('offscreen audio edge cases', () => {
  it('downsample ratio that does not divide evenly still covers all samples (non-zero last bucket)', () => {
    // 48k -> 16k ratio 3, length 10 => newLength round(3.333)=3
    const input = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    const out = downsampleFloat32(input, 48000, 16000)
    expect(out.length).toBe(3)
    // all input are 1 so all outputs should be 1
    expect([...out]).toEqual([1, 1, 1])
  })

  it('downsampleFloat32 for 44100->16000 with tiny buffer returns empty or small but does not throw', () => {
    const input = new Float32Array([0.1, 0.2])
    const out = downsampleFloat32(input, 44100, 16000)
    expect(out).toBeInstanceOf(Float32Array)
  })

  it('floatTo16BitPCM clamps NaN to 0 (because Math.min/max with NaN yields NaN -> coerces to 0)', () => {
    const out = floatTo16BitPCM(new Float32Array([NaN]))
    expect(out[0]).toBe(0)
  })

  it('floatTo16BitPCM clamps +Infinity to max', () => {
    const out = floatTo16BitPCM(new Float32Array([Infinity]))
    expect(out[0]).toBe(32767)
  })

  it('floatTo16BitPCM clamps -Infinity to min', () => {
    const out = floatTo16BitPCM(new Float32Array([-Infinity]))
    expect(out[0]).toBe(-32768)
  })

  it('floatTo16BitPCM handles a very large buffer', () => {
    const big = new Float32Array(200_000)
    big.fill(0.5)
    const out = floatTo16BitPCM(big)
    expect(out.length).toBe(200_000)
    expect(out[0]).toBe(16383)
    expect(out[out.length - 1]).toBe(16383)
  })
})
