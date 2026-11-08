import { describe, expect, it } from 'vitest'
import { decodePolyline, encodePolyline, haversineMiles } from './polyline'

// Google's documented example: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
const GOOGLE_VECTOR = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'

describe('polyline', () => {
  it('decodes the documented vector', () => {
    const path = decodePolyline(GOOGLE_VECTOR)
    expect(path).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ])
  })

  it('round-trips encode(decode(x))', () => {
    expect(encodePolyline(decodePolyline(GOOGLE_VECTOR))).toBe(GOOGLE_VECTOR)
  })

  it('survives a truncated string without throwing', () => {
    expect(decodePolyline(GOOGLE_VECTOR.slice(0, 7)).length).toBeLessThanOrEqual(1)
    expect(decodePolyline('')).toEqual([])
  })

  it('measures great-circle miles', () => {
    // Chicago to Toledo is roughly 220 miles as the crow flies.
    const d = haversineMiles({ lat: 41.8781, lng: -87.6298 }, { lat: 41.6528, lng: -83.5379 })
    expect(d).toBeGreaterThan(205)
    expect(d).toBeLessThan(235)
    expect(haversineMiles({ lat: 1, lng: 1 }, { lat: 1, lng: 1 })).toBe(0)
  })
})
