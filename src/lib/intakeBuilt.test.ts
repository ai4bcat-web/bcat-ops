import { describe, expect, it } from 'vitest'
import { autoLinkTarget, builtMatchesFor, keyTokens, needsBuiltCheck, normRef, refCandidates, storedBuiltMatches, subjectTokens, type BuiltShipment } from './intakeBuilt'
import { NOT_DUPLICATE_TOKEN } from './intakeDup'
import type { IntakeLoadRecord } from '../types/intake'

function row(over: Partial<IntakeLoadRecord> & { reference?: string | null; customerId?: string | null } = {}): IntakeLoadRecord {
  const { reference = null, customerId = null, ...rest } = over
  return {
    id: 'i1', status: 'OPEN', subject: 'Fwd: Carrier Load Tender 23022601LN (LoadID)', shipmentId: null, confirmed: [], dismissReason: null,
    fields: { reference, customerId, pickupNumber: null, deliveryNumber: null, stops: [] },
    ...rest,
  } as unknown as IntakeLoadRecord
}
const ship = (over: Partial<BuiltShipment> = {}): BuiltShipment => ({
  id: 's1', number: '20043', customerId: 'c1', customerName: 'C.H. ROBINSON', searchKey: '20043 c.h. robinson mesa az 573570079 23022601ln', ...over,
})

describe('normalising and candidates', () => {
  it('ignores punctuation and case', () => {
    expect(normRef('FR-113188-3')).toBe('fr1131883')
  })
  it('takes number-looking subject words but not dates, short words or plain words', () => {
    expect(subjectTokens('Fwd: Rate Confirmation for Load: 69902922')).toEqual(['69902922'])
    expect(subjectTokens('Carrier Load Tender 23022601LN (LoadID)')).toEqual(['23022601LN'])
    expect(subjectTokens('Load 20261111 for Tuesday AB12')).toEqual([])
  })
  it('lists parsed fields as reference and subject words as the weaker source', () => {
    const c = refCandidates(row({ reference: '573570079', subject: 'Tender 23022601LN' }))
    expect(c.map((x) => [x.norm, x.source])).toEqual([['573570079', 'reference'], ['23022601ln', 'subject']])
  })
  it('the same number in both counts once, as a reference', () => {
    const c = refCandidates(row({ reference: '69902922', subject: 'Rate Confirmation for Load: 69902922' }))
    expect(c).toHaveLength(1)
    expect(c[0].source).toBe('reference')
  })
})

describe('matching shipments', () => {
  it('matches a parsed reference on a whole word of the key', () => {
    const m = builtMatchesFor(row({ reference: '573570079' }), [ship()])
    expect(m).toEqual([expect.objectContaining({ shipmentId: 's1', number: '20043', source: 'reference' })])
  })
  it('does not match inside a longer number', () => {
    expect(builtMatchesFor(row({ reference: '73570079', subject: 'Tender' }), [ship()])).toEqual([])
  })
  it('matches a subject number as the weaker source', () => {
    const m = builtMatchesFor(row(), [ship()])
    expect(m).toEqual([expect.objectContaining({ number: '20043', source: 'subject', value: '23022601LN' })])
  })
  it('ignores punctuation differences', () => {
    const m = builtMatchesFor(row({ reference: 'FR-113188-3' }), [ship({ searchKey: '20043 the royal group fr1131883' })])
    expect(m).toHaveLength(1)
  })
  it('a reference equal to the PRO itself is not a reference', () => {
    expect(builtMatchesFor(row({ reference: '20043' }), [ship({ searchKey: '20043 c.h. robinson' })])).toEqual([])
    expect(keyTokens('20043 abc 12345', '20043').has('20043')).toBe(false)
  })
  it('a different known customer is not the same load; an unknown one still flags', () => {
    expect(builtMatchesFor(row({ reference: '573570079', customerId: 'c9' }), [ship()])).toEqual([])
    expect(builtMatchesFor(row({ reference: '573570079', customerId: 'c1' }), [ship()])).toHaveLength(1)
    expect(builtMatchesFor(row({ reference: '573570079', customerId: null }), [ship()])).toHaveLength(1)
  })
  it('skips voided or deleted shipments and the shipment the row already became', () => {
    expect(builtMatchesFor(row({ reference: '573570079' }), [ship({ voidedAt: '2026-11-01' })])).toEqual([])
    expect(builtMatchesFor(row({ reference: '573570079' }), [ship({ deletedAt: '2026-11-01' })])).toEqual([])
    expect(builtMatchesFor(row({ reference: '573570079', shipmentId: 's1' }), [ship()])).toEqual([])
  })
  it('lists the parsed-reference match before a subject-only one', () => {
    const shipments = [ship({ id: 'a', number: '20050', searchKey: '20050 x 23022601ln' }), ship({ id: 'b', number: '20043' })]
    const m = builtMatchesFor(row({ reference: '573570079' }), shipments)
    expect(m.map((x) => x.number)).toEqual(['20043', '20050'])
  })
})

describe('which rows are checked', () => {
  it('only open rows without a shipment that are not deleted or marked not a duplicate', () => {
    expect(needsBuiltCheck(row())).toBe(true)
    expect(needsBuiltCheck(row({ status: 'MOVED' as never }))).toBe(false)
    expect(needsBuiltCheck(row({ shipmentId: 's1' }))).toBe(false)
    expect(needsBuiltCheck(row({ confirmed: [NOT_DUPLICATE_TOKEN] }))).toBe(false)
    expect(needsBuiltCheck(row({ status: 'DISMISSED' as never, dismissReason: 'Deleted by admin' }))).toBe(false)
  })
})

describe('the answer staging stored on the row', () => {
  const stored = [{ shipmentId: 's1', number: '20043', customerName: 'C.H. ROBINSON', value: '573570079', source: 'reference' as const }]
  const at = '2026-11-12T10:00:00.000Z'

  it('is used while the row still holds the reference it matched', () => {
    const m = storedBuiltMatches(row({ reference: '573570079', alreadyBuilt: stored, alreadyBuiltCheckedAt: at }))
    expect(m).toEqual(stored)
  })
  it('is stale once an edit removed that reference (the screen checks again)', () => {
    expect(storedBuiltMatches(row({ reference: '999888777', subject: 'Tender', alreadyBuilt: stored, alreadyBuiltCheckedAt: at }))).toBeNull()
  })
  it('is nothing when never checked, empty, malformed, dismissed as "not a duplicate", or already a shipment', () => {
    expect(storedBuiltMatches(row({ reference: '573570079', alreadyBuilt: stored }))).toBeNull()
    expect(storedBuiltMatches(row({ reference: '573570079', alreadyBuilt: [], alreadyBuiltCheckedAt: at }))).toBeNull()
    expect(storedBuiltMatches(row({ reference: '573570079', alreadyBuilt: [{ number: '1' }] as never, alreadyBuiltCheckedAt: at }))).toBeNull()
    expect(storedBuiltMatches(row({ reference: '573570079', alreadyBuilt: stored, alreadyBuiltCheckedAt: at, confirmed: [NOT_DUPLICATE_TOKEN] }))).toBeNull()
    expect(storedBuiltMatches(row({ reference: '573570079', alreadyBuilt: stored, alreadyBuiltCheckedAt: at, shipmentId: 'sh-9' }))).toBeNull()
  })
})

describe('autoLinkTarget', () => {
  const m = (shipmentId: string, source: 'reference' | 'subject') => ({ shipmentId, number: shipmentId, customerName: null, value: '15810', source })
  it('is the one shipment matched on a parsed reference, and nothing otherwise', () => {
    expect(autoLinkTarget([m('a', 'reference')])?.shipmentId).toBe('a')
    expect(autoLinkTarget([m('a', 'subject')])).toBeNull()
    expect(autoLinkTarget([m('a', 'reference'), m('b', 'reference')])).toBeNull()
    expect(autoLinkTarget([])).toBeNull()
  })
})
