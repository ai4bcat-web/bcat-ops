import { describe, expect, it } from 'vitest'
import { detentionSummary, detentionTooltip, hoursBetween, parseDetentionFlag, validateDetentionInput } from './detentionFlag'

describe('detention flag', () => {
  it('validates the stop, works out hours from arrived/departed, and prefers typed hours', () => {
    expect(validateDetentionInput({ stopType: 'pickup', arrivedAt: '2026-11-16T12:00:00Z', departedAt: '2026-11-16T15:10:00Z' }).hours).toBe(3.25)
    expect(validateDetentionInput({ stopType: 'delivery', hours: '2.5', note: '  late dock  ' })).toMatchObject({ hours: 2.5, note: 'late dock' })
    expect(() => validateDetentionInput({ stopType: 'yard' })).toThrow(/pickup or the delivery/)
    expect(() => validateDetentionInput({ stopType: 'pickup', arrivedAt: '2026-11-16T15:00:00Z', departedAt: '2026-11-16T14:00:00Z' })).toThrow(/after arrived/)
    expect(() => validateDetentionInput({ stopType: 'pickup', hours: -1 })).toThrow(/hours waited/)
  })

  it('parses the stored JSON (string or object) and ignores junk', () => {
    const flag = { stopType: 'delivery', stopLabel: 'Delivery · IFF', hours: 4, flaggedAt: '2026-11-16T18:00:00Z', flaggedBy: 'ryne@bcatcorp.com' }
    expect(parseDetentionFlag(JSON.stringify(flag))).toEqual(flag)
    expect(parseDetentionFlag(flag)).toEqual(flag)
    expect(parseDetentionFlag(null)).toBeNull()
    expect(parseDetentionFlag('{bad')).toBeNull()
    expect(parseDetentionFlag({ stopType: 'delivery' })).toBeNull()
  })

  it('reads as a summary and a tooltip', () => {
    const flag = { stopType: 'delivery' as const, stopLabel: 'Delivery · IFF', hours: 4, note: 'No door', flaggedAt: 'T', flaggedBy: 'ryne@bcatcorp.com' }
    expect(detentionSummary(flag)).toBe('Delivery · IFF · 4 hrs')
    expect(detentionTooltip(flag, (iso) => iso)).toBe('Detention at Delivery · IFF · 4 hrs\nNo door\nFlagged by ryne@bcatcorp.com · T')
    expect(hoursBetween(null, 'x')).toBeNull()
  })
})
