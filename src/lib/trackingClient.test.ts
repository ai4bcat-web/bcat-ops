import { describe, it, expect } from 'vitest'
import { newTrackingCode, trackingLinkFor } from './trackingClient'

describe('tracking codes', () => {
  it('makes 12-character codes without look-alike characters, different each time', () => {
    const a = newTrackingCode(), b = newTrackingCode()
    expect(a).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/)
    expect(a).not.toBe(b)
  })
  it('builds the public link on our own domain', () => {
    expect(trackingLinkFor('abc123def456', 'https://ops.bcatcorp.com')).toBe('https://ops.bcatcorp.com/track/abc123def456')
  })
})
