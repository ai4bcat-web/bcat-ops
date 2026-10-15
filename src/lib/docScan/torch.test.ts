import { describe, it, expect, vi } from 'vitest'
import { torchSupported, setTorch, frameBrightness, autoTorchWants, nextTorchMode } from './torch'

describe('torch', () => {
  it('is supported only when the track says so', () => {
    expect(torchSupported({ getCapabilities: () => ({ torch: true }) } as unknown as MediaStreamTrack)).toBe(true)
    expect(torchSupported({ getCapabilities: () => ({}) } as unknown as MediaStreamTrack)).toBe(false)
    expect(torchSupported({} as MediaStreamTrack)).toBe(false)   // iPhone: no getCapabilities torch
    expect(torchSupported(null)).toBe(false)
  })
  it('applies the constraint and reports a refusal instead of throwing', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    expect(await setTorch({ applyConstraints: apply } as unknown as MediaStreamTrack, true)).toBe(true)
    expect(apply).toHaveBeenCalledWith({ advanced: [{ torch: true }] })
    expect(await setTorch({ applyConstraints: vi.fn().mockRejectedValue(new Error('no')) } as unknown as MediaStreamTrack, true)).toBe(false)
    expect(await setTorch({} as MediaStreamTrack, true)).toBe(false)
  })
})

describe('auto flash', () => {
  it('reads the light off the frame', () => {
    const dark = new Uint8ClampedArray(64 * 4).fill(20)
    const bright = new Uint8ClampedArray(64 * 4).fill(200)
    expect(frameBrightness(dark)).toBeCloseTo(20, 0)
    expect(frameBrightness(bright)).toBeCloseTo(200, 0)
  })
  it('comes on in the dark, goes off in good light, and holds in between', () => {
    expect(autoTorchWants(30, false)).toBe(true)
    expect(autoTorchWants(150, true)).toBe(false)
    expect(autoTorchWants(80, true)).toBe(true)
    expect(autoTorchWants(80, false)).toBe(false)
  })
  it('cycles auto → on → off → auto', () => {
    expect(nextTorchMode('auto')).toBe('on'); expect(nextTorchMode('on')).toBe('off'); expect(nextTorchMode('off')).toBe('auto')
  })
})
