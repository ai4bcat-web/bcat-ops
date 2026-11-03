import { describe, expect, it } from 'vitest'
import { needsLine } from './flowDefaults'
import {
  buildIntakeDraft, canMoveToActive, correctedKeys, emptyIntakeFields, fieldStatusOf, intakeCounts,
  intakeMissing, intakeRequired, patchIntakeFields, toCreateShipmentInput,
} from './intakeLoad'
import type { TenderPrefill } from './intakeTender'
import type { IntakeFields, IntakeLoadRecord, IntakeMeta } from '../types/intake'

const parserTender: TenderPrefill = {
  format: 'E2OPEN', reference: '208663813', pickupNumber: 'SO-1', customer: 'Batory Foods', weightLb: 40000,
  stops: [
    { type: 'pickup', city: 'CHICAGO', state: 'IL', zip: '60609', dateStr: '2026-08-04' },
    { type: 'delivery', city: 'WAUKEGAN', state: 'IL', zip: '60085', dateStr: '2026-08-05' },
  ],
}
const NO_PARTY = { kind: null, id: null, name: null, how: null, candidates: [] }
const EMAIL_PARTY = { kind: 'CUSTOMER', id: 'c1', name: 'Batory Foods', how: 'EMAIL', candidates: [] }

const draft = (over: Partial<Parameters<typeof buildIntakeDraft>[0]> = {}) => buildIntakeDraft({
  tender: parserTender, parserTender, fillKind: 'NONE', lowConfidence: [], party: EMAIL_PARTY,
  customer: { defaultSalesRepId: 'rep1' }, divisionCode: 'BROKERAGE', stopFacilityHits: [false, false], ...over,
})

/** A fully built, confirmed load: only what the shipment page would also require. */
function readyRow(): Pick<IntakeLoadRecord, 'fields' | 'meta' | 'confirmed'> {
  const d = draft({ customer: { defaultSalesRepId: 'rep1', defaultBillToId: 'bt1' } })
  return { fields: { ...d.fields, customerRateCents: 150000, deliveryNumber: 'D1' }, meta: d.meta, confirmed: [] }
}
interface StopOut { type: string; city: string; sequence: number; appt: string; apptStatus?: string }
interface ShipmentInput { customerId: string; load: { stops: StopOut[]; notes?: string } & Record<string, unknown> }
const ctx = { settings: null, customer: null, customerActive: true, divisionActive: true }

describe('buildIntakeDraft provenance', () => {
  it('parser values are PARSER/high', () => {
    const d = draft()
    expect(d.meta.reference).toEqual({ source: 'PARSER', confidence: 'high' })
    expect(d.meta['stops.0.city']).toEqual({ source: 'PARSER', confidence: 'high' })
    expect(d.fields.divisionCode).toBe('BROKERAGE')
    expect(d.meta.divisionCode.source).toBe('ADDRESS')
    expect(d.meta.salesRepId.source).toBe('DEFAULT')
  })

  it('model-only values are MODEL; keys the model flagged are low', () => {
    const tender: TenderPrefill = { format: null, reference: '99999', pickupNumber: 'P9', stops: [{ type: 'pickup', city: 'Gary', state: 'IN' }, { type: 'delivery', city: 'Joliet', state: 'IL' }] }
    const d = draft({ tender, parserTender: { format: null, stops: [] }, fillKind: 'EMAIL', lowConfidence: ['pickupNumber', 'stops.1.city'] })
    expect(d.meta.reference).toEqual({ source: 'MODEL', confidence: 'high' })
    expect(d.meta.pickupNumber).toEqual({ source: 'MODEL', confidence: 'low' })
    expect(d.meta['stops.1.city'].confidence).toBe('low')
    expect(d.meta['stops.0.city'].confidence).toBe('high')
  })

  it('customer: EMAIL match is high; DOMAIN/NAME is low; none is missing with candidates kept', () => {
    expect(draft().meta.customerId.confidence).toBe('high')
    expect(draft({ party: { ...EMAIL_PARTY, how: 'DOMAIN' } }).meta.customerId.confidence).toBe('low')
    const candidates = [{ id: 'c2', name: 'Batory Inc', how: 'NAME' }]
    const none = draft({ party: { ...NO_PARTY, candidates } })
    expect(none.fields.customerId).toBeNull()
    expect(fieldStatusOf('customerId', none.fields, none.meta, [])).toBe('MISSING')
    expect(none.customerCandidates).toEqual(candidates)
    expect(none.fields.customerName).toBe('Batory Foods')
  })

  it('format-invalid values are low whatever the source', () => {
    const bad: TenderPrefill = { format: 'E2OPEN', weightLb: 90000, stops: [
      { type: 'pickup', city: 'A', state: 'Illinois', zip: '1234', dateStr: '2026-13-40', time: '25:00' },
      { type: 'delivery', city: 'B', state: 'IL' }] }
    const d = draft({ tender: bad, parserTender: bad })
    for (const key of ['weightLb', 'stops.0.state', 'stops.0.zip', 'stops.0.date', 'stops.0.time']) {
      expect(d.meta[key].confidence, key).toBe('low')
    }
  })

  it('a known facility fills the stop name as DIRECTORY', () => {
    const t: TenderPrefill = { ...parserTender, stops: [{ ...parserTender.stops[0], name: 'ACME DC' }, parserTender.stops[1]] }
    const d = draft({ tender: t, stopFacilityHits: [true, false] })
    expect(d.meta['stops.0.name'].source).toBe('DIRECTORY')
  })
})

describe('fieldStatusOf', () => {
  it('MISSING / LOW / AUTO / CONFIRMED / INVALID transitions', () => {
    const d = draft({ party: { ...EMAIL_PARTY, how: 'NAME' } })
    expect(fieldStatusOf('customerId', d.fields, d.meta, [])).toBe('LOW')
    expect(fieldStatusOf('customerId', d.fields, d.meta, ['customerId'])).toBe('CONFIRMED')
    expect(fieldStatusOf('reference', d.fields, d.meta, [])).toBe('AUTO')
    expect(fieldStatusOf('commodity', d.fields, d.meta, [])).toBe('MISSING')
    const edited = patchIntakeFields({ ...d, confirmed: [] }, { reference: '777777' }, { add: [], remove: [] })
    expect(fieldStatusOf('reference', edited.fields, edited.meta, [])).toBe('CONFIRMED')
    const bad = patchIntakeFields({ ...d, confirmed: [] }, { stops: [{ ...d.fields.stops[0], state: 'Illinois' }, d.fields.stops[1]] }, { add: [], remove: [] })
    expect(fieldStatusOf('stops.0.state', bad.fields, bad.meta, [])).toBe('INVALID')
  })
})

describe('intakeRequired', () => {
  it('is defaults ∪ customer, drops carrierRep/bolNumber into deferred', () => {
    const r = intakeRequired({ defaultRequiredLoadFields: ['billTo'] }, { requiredLoadFields: ['carrierRep', 'bolNumber', 'weight'] })
    expect(r.gated).toEqual(['billTo', 'weight'])
    expect(r.deferred).toEqual(['bolNumber', 'carrierRep'])
  })
  it('unknown stale keys are deferred, not gating', () => {
    expect(intakeRequired(null, { requiredLoadFields: ['nonsense'] }).deferred).toContain('nonsense')
  })
})

describe('canMoveToActive', () => {
  it('passes a complete, confirmed load', () => {
    expect(canMoveToActive(readyRow(), ctx)).toEqual({ ok: true, missing: [], problems: [], unconfirmed: [] })
  })

  it('blocks on each hard minimum and on a missing default-required field', () => {
    const base = readyRow()
    const without = (patch: Partial<IntakeFields>) => canMoveToActive({ ...base, fields: { ...base.fields, ...patch } }, ctx)
    expect(without({ customerId: null }).ok).toBe(false)
    expect(without({ divisionCode: null }).ok).toBe(false)
    expect(without({ stops: base.fields.stops.filter((s) => s.type === 'pickup') }).problems.join()).toMatch(/delivery/)
    const badState = base.fields.stops.map((s, i) => (i === 0 ? { ...s, state: 'Illinois' } : s))
    expect(without({ stops: badState }).problems.join()).toMatch(/two-letter state/)
    const noBillTo = without({ billToId: null })
    expect(noBillTo.ok).toBe(false)
    expect(noBillTo.missing).toEqual(['Bill-to party'])
  })

  it('blocks on an unconfirmed LOW field until it is confirmed', () => {
    const base = readyRow()
    const meta: IntakeMeta = { ...base.meta, reference: { source: 'MODEL', confidence: 'low' } }
    const blocked = canMoveToActive({ ...base, meta }, ctx)
    expect(blocked.ok).toBe(false)
    expect(blocked.unconfirmed).toEqual(['reference'])
    expect(canMoveToActive({ ...base, meta, confirmed: ['reference'] }, ctx).ok).toBe(true)
  })

  it('missing labels equal the shipment page needsLine for the same keys', () => {
    const base = readyRow()
    const fields = { ...base.fields, billToId: null, salesRepId: null }
    const keys = intakeMissing(fields, intakeRequired(null, null).gated)
    const result = canMoveToActive({ ...base, fields }, ctx)
    expect(`Needs: ${result.missing.join(', ')}`).toBe(needsLine(keys))
  })
})

describe('patchIntakeFields / correctedKeys', () => {
  it('marks only changed keys as REVIEWER and confirm add/remove apply', () => {
    const d = draft()
    const out = patchIntakeFields({ ...d, confirmed: ['pickupNumber'] }, { commodity: ' Steel ', weightLb: 40000 }, { add: ['reference'], remove: ['pickupNumber'] })
    expect(out.fields.commodity).toBe('Steel')
    expect(out.meta.commodity.source).toBe('REVIEWER')
    expect(out.meta.weightLb.source).toBe('PARSER')
    expect(out.confirmed).toEqual(['reference'])
  })

  it('shrinking the stop list drops provenance of removed stops', () => {
    const d = draft()
    const out = patchIntakeFields({ ...d, confirmed: ['stops.1.city'] }, { stops: [d.fields.stops[0]] }, { add: [], remove: [] })
    expect(out.meta['stops.1.city']).toBeUndefined()
    expect(out.confirmed).toEqual([])
  })

  it('correctedKeys lists what the reviewer changed against the automatic draft', () => {
    const d = draft()
    const out = patchIntakeFields({ ...d, confirmed: [] }, { reference: '1', stops: [{ ...d.fields.stops[0], city: 'GARY' }, d.fields.stops[1]] }, { add: [], remove: [] })
    expect(correctedKeys(d.fields, out.fields)).toEqual(['reference', 'stops.0.city'])
    expect(correctedKeys(d.fields, d.fields)).toEqual([])
  })
})

describe('toCreateShipmentInput', () => {
  it('maps like the tender dialog: pickups first, date-only vs exact appointments, TENDER source', () => {
    const fields: IntakeFields = { ...emptyIntakeFields(), customerId: 'c1', reference: '123456', pickupNumber: 'P1', weightLb: 40000.4, customerRateCents: 150000,
      stops: [
        { type: 'delivery', name: null, street: null, city: 'B', state: 'IL', zip: null, date: '2026-08-05', time: '09:30', instructions: 'Call ahead' },
        { type: 'pickup', name: 'ACME', street: '1 Main St', city: 'A', state: 'IN', zip: '46402', date: '2026-08-04', time: null, instructions: 'Call ahead' }] }
    const input = toCreateShipmentInput(fields, { requiresApptProofs: false, runId: 'wf:TENDER:x' }) as unknown as ShipmentInput
    expect(input).toMatchObject({ customerId: 'c1', source: 'TENDER', workflowRunId: 'wf:TENDER:x' })
    expect(input.load).toMatchObject({ tmsId: '123456', pickupNumber: 'P1', weight: 40000, rateCents: 150000, notes: 'Pickup: Call ahead\nDelivery: Call ahead' })
    expect(input.load.stops.map((s: StopOut) => [s.type, s.city, s.sequence])).toEqual([['pickup', 'A, IN', 0], ['delivery', 'B, IL', 1]])
    expect(input.load.stops[0].appt).toBe(new Date(input.load.stops[0].appt).toISOString())
    expect(input.load.stops[1].appt > input.load.stops[0].appt).toBe(true)
  })

  it('Batory-style customers get no appointments or notes and the request ladder', () => {
    const d = draft()
    const input = toCreateShipmentInput(d.fields, { requiresApptProofs: true, runId: 'r' }) as unknown as ShipmentInput
    expect(input.load.stops.map((s: StopOut) => [s.appt, s.apptStatus])).toEqual([['', 'need_request'], ['', 'need_book']])
    expect(input.load.notes).toBeUndefined()
  })
})

describe('intakeCounts', () => {
  it('counts missing from the stored list and LOW fields still to check', () => {
    const d = draft({ party: { ...EMAIL_PARTY, how: 'DOMAIN' } })
    const row = { fields: d.fields, meta: d.meta, confirmed: [], missingFields: ['billTo', 'salesRep'] } as unknown as IntakeLoadRecord
    expect(intakeCounts(row)).toMatchObject({ missing: 2, toCheck: 2 })
  })
})
