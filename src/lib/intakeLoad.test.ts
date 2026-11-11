import { describe, expect, it } from 'vitest'
import { needsLine } from './flowDefaults'
import { isDemoText } from './demoFlow'
import {
  buildIntakeDraft, mergeIntakeFields, canMarkReviewed, canMoveToActive, correctedKeys, customerDefaultsOf, emptyIntakeFields, fieldStatusOf, intakeCounts,
  ensureRequiredStops, INTAKE_ALWAYS_REQUIRED, intakeMissing, intakeRequired, isDemoIntake, patchIntakeFields, toCreateShipmentInput, withCustomerDefaults,
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

/** A fully built, confirmed, reviewed load: only what the shipment page would also require. */
function readyRow(): Pick<IntakeLoadRecord, 'fields' | 'meta' | 'confirmed' | 'reviewedBy' | 'reviewedAt'> {
  const d = draft({ customer: { defaultSalesRepId: 'rep1', defaultBillToId: 'bt1' } })
  return {
    // Every pickup / delivery carries a street, a date and a time: they are mandatory.
    fields: { ...d.fields, customerRateCents: 150000, deliveryNumber: 'D1', stops: d.fields.stops.map((s, i) => ({ ...s, street: s.street ?? `${i + 1} Dock Rd`, time: s.time ?? '08:00', date: s.date ?? '2026-11-10' })) },
    meta: d.meta,
    confirmed: [],
    reviewedBy: 'rev@bcatcorp.com',
    reviewedAt: '2026-11-03T16:00:00.000Z',
  }
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

describe('shipment type', () => {
  const withType = (shipmentType: string) => draft({
    tender: { format: null, shipmentType, stops: [] }, parserTender: { format: null, stops: [] }, fillKind: 'EMAIL',
  })

  it('carries a model-read key, marked MODEL', () => {
    const d = withType('REEFER')
    expect(d.fields.shipmentType).toBe('REEFER')
    expect(d.meta.shipmentType).toEqual({ source: 'MODEL', confidence: 'high' })
  })

  it('leaves it blank when the message names none or a key off the list', () => {
    expect(draft().fields.shipmentType).toBeNull()
    expect(withType('SPACESHIP').fields.shipmentType).toBeNull()
  })

  it('a reviewer-typed key off the list reads INVALID', () => {
    const d = withType('REEFER')
    const row = { fields: d.fields, meta: d.meta, confirmed: [] }
    const patched = patchIntakeFields(row, { shipmentType: 'NOPE' }, { add: [], remove: [] })
    expect(fieldStatusOf('shipmentType', patched.fields, patched.meta, [])).toBe('INVALID')
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
    expect(r.gated).toEqual(['billTo', 'weight', ...INTAKE_ALWAYS_REQUIRED])
    expect(r.deferred).toEqual(['bolNumber', 'carrierRep'])
  })
  it('always gates the pickup / delivery address, appointment and numbers, even with no required-field list at all', () => {
    expect(intakeRequired(null, null).gated).toEqual(expect.arrayContaining([...INTAKE_ALWAYS_REQUIRED]))
  })
  it('unknown stale keys are deferred, not gating', () => {
    expect(intakeRequired(null, { requiredLoadFields: ['nonsense'] }).deferred).toContain('nonsense')
  })
})

describe('mandatory pickup and delivery', () => {
  const base = () => readyRow()
  const withStops = (patch: Partial<IntakeFields['stops'][number]>, index = 0) => {
    const b = base()
    return canMoveToActive({ ...b, fields: { ...b.fields, stops: b.fields.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)) } }, ctx)
  }
  it('every stop needs a street, a date and a time', () => {
    expect(withStops({ street: null }).problems).toContain('Stop 1 needs a street address')
    expect(withStops({ date: null }).problems).toContain('Stop 1 needs a pickup date')
    expect(withStops({ time: null }, 1).problems).toContain('Stop 2 needs a delivery time')
  })
  it('a pickup number and a delivery number are required', () => {
    const b = base()
    expect(canMoveToActive({ ...b, fields: { ...b.fields, pickupNumber: null } }, ctx).missing).toContain('Pickup number')
    expect(canMoveToActive({ ...b, fields: { ...b.fields, deliveryNumber: null } }, ctx).missing).toContain('Delivery number')
  })
  it('ensureRequiredStops adds an empty pickup and delivery only when a kind is absent, and never moves an existing stop', () => {
    const empty = ensureRequiredStops(emptyIntakeFields())
    expect(empty.stops.map((s) => s.type)).toEqual(['pickup', 'delivery'])
    const onlyDelivery = { ...emptyIntakeFields(), stops: [{ ...empty.stops[1]!, city: 'Dallas' }] }
    const out = ensureRequiredStops(onlyDelivery)
    expect(out.stops.map((s) => s.type)).toEqual(['delivery', 'pickup'])
    expect(out.stops[0]!.city).toBe('Dallas')
    const full = readyRow().fields
    expect(ensureRequiredStops(full)).toBe(full)
  })
  it('a driver pick is a reviewer edit that is saved on the draft', () => {
    const b = base()
    const out = patchIntakeFields({ fields: b.fields, meta: b.meta, confirmed: [] }, { driverId: 'drv1' }, { add: [], remove: [] })
    expect(out.fields.driverId).toBe('drv1')
    expect(out.meta.driverId).toEqual({ source: 'REVIEWER', confidence: 'high' })
  })
})

describe('canMoveToActive', () => {
  it('passes a complete, confirmed load', () => {
    expect(canMoveToActive(readyRow(), ctx)).toEqual({ ok: true, missing: [], problems: [], unconfirmed: [], needsReview: false })
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

  it('Bill to is only asked when the customer has separate bill-to parties; a customer billed itself never reads Missing', () => {
    const fields = { ...readyRow().fields, billToId: null }
    const gated = intakeRequired(null, null).gated
    expect(intakeMissing(fields, gated)).toContain('billTo')
    expect(intakeMissing(fields, gated, { billToParties: [] })).not.toContain('billTo')
    expect(intakeMissing(fields, gated, { billToParties: '[]' })).not.toContain('billTo')
    expect(intakeMissing(fields, gated, { billToParties: [{ id: 'b1', name: 'AP' }] })).toContain('billTo')
    expect(intakeMissing({ ...fields, billToId: 'b1' }, gated, { billToParties: [{ id: 'b1', name: 'AP' }] })).not.toContain('billTo')
  })

  it('a complete, fully confirmed load can move without anyone marking it reviewed (there is no review step)', () => {
    const base = readyRow()
    const unreviewed = { ...base, reviewedBy: null, reviewedAt: null }
    expect(canMoveToActive(unreviewed, ctx)).toEqual({ ok: true, missing: [], problems: [], unconfirmed: [], needsReview: false })
    expect(canMoveToActive({ ...base, reviewedAt: null }, ctx).needsReview).toBe(false)
  })

  it('an incomplete load cannot be marked reviewed, and a review does not rescue it', () => {
    const base = readyRow()
    const fields = { ...base.fields, billToId: null }
    expect(canMarkReviewed({ ...base, fields }, ctx).ok).toBe(false)
    const moved = canMoveToActive({ ...base, fields }, ctx)
    expect(moved).toMatchObject({ ok: false, needsReview: false })
    expect(moved.missing).toEqual(['Bill-to party'])
  })
})

describe('customer defaults for a new load', () => {
  const owner = { accountOwnerIds: ['owner@bcatcorp.com', 'second@bcatcorp.com'] }

  it('takes the default rep, else the primary account owner, and the bill-to marked default', () => {
    expect(customerDefaultsOf({ defaultSalesRepId: 'rep1', ...owner, billToParties: [{ id: 'a' }, { id: 'b', isDefault: true }] })).toEqual({ salesRepId: 'rep1', billToId: 'b' })
    expect(customerDefaultsOf({ ...owner, billToParties: [{ id: 'a', isDefault: true }] })).toEqual({ salesRepId: 'owner@bcatcorp.com', billToId: 'a' })
    // No party flagged default: the only party is the default; with several and none flagged, nothing is guessed.
    expect(customerDefaultsOf({ ...owner, billToParties: [{ id: 'only' }] }).billToId).toBe('only')
    expect(customerDefaultsOf({ ...owner, billToParties: [{ id: 'a' }, { id: 'b' }] }).billToId).toBeNull()
    expect(customerDefaultsOf({ ...owner, billToParties: [] }).billToId).toBeNull()
    expect(customerDefaultsOf({ billToParties: JSON.stringify([{ id: 'j', isDefault: true }]) }).billToId).toBe('j')
  })

  it('a customer without defaults leaves both empty, and several parties with none marked default are no choice', () => {
    expect(customerDefaultsOf({ billToParties: [{ id: 'only' }] }).billToId).toBe('only')
    expect(customerDefaultsOf({ accountOwnerIds: [], billToParties: [] })).toEqual({ salesRepId: null, billToId: null })
    expect(customerDefaultsOf(null)).toEqual({ salesRepId: null, billToId: null })
    expect(customerDefaultsOf({ billToParties: [{ id: 'a' }, { id: 'b' }] }).billToId).toBeNull()
  })

  it('the staged draft starts with the defaults, marked DEFAULT, and no longer waits on a review', () => {
    const d = draft({ customer: { accountOwnerIds: ['owner@bcatcorp.com'], billToParties: [{ id: 'bt1', isDefault: true }] } })
    expect(d.fields).toMatchObject({ salesRepId: 'owner@bcatcorp.com', billToId: 'bt1' })
    expect(d.meta.salesRepId.source).toBe('DEFAULT')
    const row = { fields: { ...d.fields, customerRateCents: 150000, deliveryNumber: 'D1' }, meta: d.meta, confirmed: [], reviewedBy: null, reviewedAt: null }
    expect(canMoveToActive(row, ctx)).toMatchObject({ needsReview: false, missing: [] })
  })

  it('a customer without defaults leaves the fields empty and the gate still blocks on them', () => {
    const d = draft({ customer: { billToParties: [{ id: 'a' }, { id: 'b' }] } })
    expect(d.fields.salesRepId).toBeNull()
    expect(d.fields.billToId).toBeNull()
    expect(d.meta.salesRepId).toBeUndefined()
    const row = { fields: { ...d.fields, customerRateCents: 150000, deliveryNumber: 'D1' }, meta: d.meta, confirmed: [], reviewedBy: 'rev@bcatcorp.com', reviewedAt: '2026-11-03T16:00:00.000Z' }
    const moved = canMoveToActive(row, ctx)
    expect(moved.ok).toBe(false)
    expect(moved.missing).toEqual(expect.arrayContaining(['Bill-to party', 'Sales rep']))
  })

  it('picking a customer on the review page swaps the bill-to, only fills a blank rep, and never confirms', () => {
    const d = draft({ customer: { defaultSalesRepId: 'rep1', billToParties: [{ id: 'old', isDefault: true }] } })
    const picked = withCustomerDefaults({ ...d, confirmed: ['billToId'] }, { defaultSalesRepId: 'other', billToParties: [{ id: 'new', isDefault: true }] })
    expect(picked.fields).toMatchObject({ billToId: 'new', salesRepId: 'rep1' })
    expect(picked.confirmed).toEqual([])
    const bare = withCustomerDefaults({ ...d, confirmed: [] }, { billToParties: [{ id: 'a' }, { id: 'b' }] })
    expect(bare.fields.billToId).toBeNull()
    expect(bare.meta.billToId).toBeUndefined()
    const blankRep = withCustomerDefaults({ ...d, confirmed: [], fields: { ...d.fields, salesRepId: null } }, { defaultSalesRepId: 'other' })
    expect(blankRep.fields.salesRepId).toBe('other')
    expect(blankRep.meta.salesRepId.source).toBe('DEFAULT')
  })
})

describe('Demo chip matching', () => {
  const row = (over: Partial<Parameters<typeof isDemoIntake>[0]> = {}) => ({ fields: { ...emptyIntakeFields(), ...over.fields }, fromName: null, subject: null, divisionCode: null, ...over }) as Parameters<typeof isDemoIntake>[0]

  it('matches the ZZ DEMO naming wherever the demo script puts it, and nothing else', () => {
    expect(isDemoText('ZZ DEMO Customer 695311')).toBe(true)
    expect(isDemoText(null, 'ZZ_DEMO_1793791695311')).toBe(true)
    expect(isDemoText('ZZDEMO-695311')).toBe(true)
    expect(isDemoText('zz demo shipper')).toBe(true)
    expect(isDemoText('Acme Foods', 'Demo Dispatcher', 'ZZ Carrier', null, undefined)).toBe(false)
    expect(isDemoIntake(row({ fields: { ...emptyIntakeFields(), customerName: 'ZZ DEMO Customer 1' } }))).toBe(true)
    expect(isDemoIntake(row({ divisionCode: 'ZZ_DEMO_17' }))).toBe(true)
    expect(isDemoIntake(row({ subject: 'Tender 123', fromName: 'Real Shipper' }))).toBe(false)
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

describe('a tender read from its rate confirmation PDF', () => {
  it('fills equipment, commodity, the delivery number and the customer rate, marked as read from the document', () => {
    const tender: TenderPrefill = {
      ...parserTender, format: null, reference: undefined, pickupNumber: undefined,
      equipmentType: '53 dry van', commodity: 'Frozen foods', deliveryNumber: 'DEL-77', customerRateCents: 165000,
    }
    const d = draft({ tender, parserTender: { ...parserTender, format: null, reference: undefined, pickupNumber: undefined, weightLb: undefined, stops: [] }, fillKind: 'RATECON' })
    expect(d.fields).toMatchObject({ equipmentType: '53 dry van', commodity: 'Frozen foods', deliveryNumber: 'DEL-77', customerRateCents: 165000 })
    expect(d.meta.equipmentType).toMatchObject({ source: 'RATECON', confidence: 'high' })
    expect(d.meta.customerRateCents).toMatchObject({ source: 'RATECON' })
  })

  it('leaves them blank when the document does not state them', () => {
    const d = draft()
    expect(d.fields).toMatchObject({ equipmentType: null, commodity: null, deliveryNumber: null, customerRateCents: null })
  })
})

describe('mergeIntakeFields', () => {
  const stop = (type: 'pickup' | 'delivery', over: Partial<IntakeFields['stops'][number]> = {}) => ({ type, name: null, street: null, city: null, state: null, zip: null, date: null, time: null, instructions: null, ...over })
  it('fills only what the row has no value for, scalars and stop fields alike', () => {
    const existing: IntakeFields = { ...emptyIntakeFields(), reference: 'R1', commodity: 'typed', stops: [stop('pickup', { city: 'Joliet' }), stop('delivery')] }
    const incoming: IntakeFields = {
      ...emptyIntakeFields(), reference: 'OTHER', commodity: 'Frozen', equipmentType: '53 dry van', customerRateCents: 165000,
      stops: [stop('pickup', { city: 'Elsewhere', zip: '60435', street: '1 Main' }), stop('delivery', { zip: '50208' })],
    }
    const { fields, filled } = mergeIntakeFields(existing, incoming)
    expect(fields).toMatchObject({ reference: 'R1', commodity: 'typed', equipmentType: '53 dry van', customerRateCents: 165000 })
    expect(fields.stops[0]).toMatchObject({ city: 'Joliet', zip: '60435', street: '1 Main' })
    expect(fields.stops[1]).toMatchObject({ zip: '50208' })
    expect(filled.sort()).toEqual(['customerRateCents', 'equipmentType', 'stops.0.street', 'stops.0.zip', 'stops.1.zip'])
  })

  it('takes the stops when the row has none, and leaves mismatched stop lists alone', () => {
    const incoming: IntakeFields = { ...emptyIntakeFields(), stops: [stop('pickup', { city: 'A' }), stop('delivery', { city: 'B' })] }
    expect(mergeIntakeFields(emptyIntakeFields(), incoming).fields.stops).toHaveLength(2)
    const three: IntakeFields = { ...emptyIntakeFields(), stops: [stop('pickup'), stop('pickup'), stop('delivery')] }
    expect(mergeIntakeFields(three, incoming).filled).toEqual([])
  })
})

