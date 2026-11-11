import { describe, expect, it } from 'vitest'
import { DEMO_SHIPMENTS, demoShipmentFor, emailCarrierRateCents, offerCount, summarize } from './demoOffers'

describe('demoOffers seed data', () => {
  it('has 6 to 8 shipments, each with 2 to 6 offers, all labelled DEMO', () => {
    expect(DEMO_SHIPMENTS.length).toBeGreaterThanOrEqual(6)
    expect(DEMO_SHIPMENTS.length).toBeLessThanOrEqual(8)
    for (const s of DEMO_SHIPMENTS) {
      expect(s.number.startsWith('DEMO-')).toBe(true)
      expect(s.customerName).toMatch(/^Demo Customer/)
      const { total } = offerCount(s)
      expect(total).toBeGreaterThanOrEqual(2)
      expect(total).toBeLessThanOrEqual(6)
    }
  })

  it('has unique ids and fictional contact details', () => {
    const ids = DEMO_SHIPMENTS.flatMap((s) => [s.id, ...s.voiceCalls.map((c) => c.id), ...s.emailOffers.map((o) => o.id)])
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of DEMO_SHIPMENTS) {
      s.voiceCalls.forEach((c) => expect(c.fromPhone).toMatch(/\) 555-01\d\d$/))
      s.emailOffers.forEach((o) => expect(o.fromAddress.endsWith('.invalid')).toBe(true))
    }
  })

  it('covers the demo scenarios', () => {
    const sums = DEMO_SHIPMENTS.map((s) => ({ s, sum: summarize(s) }))
    expect(DEMO_SHIPMENTS.some((s) => s.voiceCalls.length > 0 && s.emailOffers.length > 0)).toBe(true)
    expect(DEMO_SHIPMENTS.some((s) => s.emailOffers.some((o) => o.outcome === 'BOOKED'))).toBe(true)
    expect(DEMO_SHIPMENTS.some((s) => s.voiceCalls.some((c) => c.outcome === 'BOOKED'))).toBe(true)
    expect(sums.some((x) => x.sum.status === 'NO_DEAL')).toBe(true)
    expect(sums.some((x) => x.sum.status === 'COUNTERED')).toBe(true)
    const outcomes = new Set(DEMO_SHIPMENTS.flatMap((s) => s.voiceCalls.map((c) => c.outcome)))
    expect(outcomes).toEqual(new Set(['BOOKED', 'ASKED_FOR_PERSON', 'NO_DEAL', 'HUNG_UP']))
  })

  it('voice calls carry a quoted range and an alternating Aiden/carrier transcript', () => {
    const call = DEMO_SHIPMENTS[0]!.voiceCalls[0]!
    expect(call.quotedLowCents).toBeLessThan(call.quotedHighCents)
    expect(call.transcript[0]).toEqual({ speaker: 'AIDEN', text: 'Cowtown Express, this is Aiden. Which load are you calling about?' })
    call.transcript.forEach((l, i) => expect(l.speaker).toBe(i % 2 === 0 ? 'AIDEN' : 'CARRIER'))
    for (const s of DEMO_SHIPMENTS) for (const c of s.voiceCalls) expect(c.agreedCents != null).toBe(c.outcome === 'BOOKED')
  })

  it('email threads alternate carrier/AI, rate counters match, booked ones have an agreed rate', () => {
    for (const s of DEMO_SHIPMENTS) for (const o of s.emailOffers) {
      expect(o.messages[0]!.from).toBe('CARRIER')
      expect(o.messages[0]!.rateCents).toBe(o.offeredCents)
      expect(o.messages.filter((m) => m.from === 'AI').map((m) => m.rateCents)).toEqual(o.counterCents)
      expect(o.agreedCents != null).toBe(o.outcome === 'BOOKED')
      expect(emailCarrierRateCents(o)).toBeGreaterThan(0)
    }
  })

  it('summarize picks the lowest carrier rate across both channels', () => {
    const s = demoShipmentFor('DEMO-4101')!
    const sum = summarize(s)
    expect(sum.status).toBe('BOOKED')
    expect(sum.lowestCents).toBe(231_000)
    expect(sum.lowestChannel).toBe('VOICE')
    expect(demoShipmentFor('nope')).toBeNull()
  })
})
