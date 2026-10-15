import { describe, it, expect, vi } from 'vitest'
import { torchSupported, setTorch } from './torch'

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
