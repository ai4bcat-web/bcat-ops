import { describe, it, expect } from 'vitest'
import {
  DRIVER_FILE_SLOTS, TRUCK_FILE_SLOTS, slotsFor, isUnslottedDoc,
  daysUntil, slotState, readyScore,
} from './fileHub'
import { TRUCK_DOC_SPECS } from './truckDocs'
import { ALL_REQUIREMENTS } from './complianceRequirements'

const TODAY = new Date(2026, 7, 5) // 2026-08-05

describe('file hub slots reuse existing document keys', () => {
  it('truck paperwork slots match Asset Documents keys, so uploads are shared', () => {
    const assetKeys = new Set(TRUCK_DOC_SPECS.map((s) => s.key))
    for (const key of ['insurance_cert', 'irp_cab_card']) {
      expect(assetKeys.has(key)).toBe(true)
      expect(TRUCK_FILE_SLOTS.some((s) => s.key === key)).toBe(true)
    }
  })

  it('driver slots match the compliance requirement catalog keys', () => {
    const catalogKeys = new Set(ALL_REQUIREMENTS.map((r) => r.key))
    for (const s of DRIVER_FILE_SLOTS) expect(catalogKeys.has(s.key)).toBe(true)
  })

  it('slot keys are unique across both entity types', () => {
    const keys = [...DRIVER_FILE_SLOTS, ...TRUCK_FILE_SLOTS].map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('selects the right slot list per entity type', () => {
    expect(slotsFor('DRIVER')).toBe(DRIVER_FILE_SLOTS)
    expect(slotsFor('TRUCK')).toBe(TRUCK_FILE_SLOTS)
  })

  it('flags document types with no slot so they still surface as "other"', () => {
    expect(isUnslottedDoc('cdl_copy')).toBe(false)
    expect(isUnslottedDoc('photo_plate')).toBe(false)
    expect(isUnslottedDoc('lease_agreement')).toBe(true)
  })

  it('photos never expire; paperwork does', () => {
    for (const s of TRUCK_FILE_SLOTS) {
      if (s.kind === 'photo') expect(s.expires).toBe(false)
    }
    expect(TRUCK_FILE_SLOTS.find((s) => s.key === 'insurance_cert')?.expires).toBe(true)
  })
})

describe('slot state', () => {
  it('counts days to an expiration date', () => {
    expect(daysUntil('2026-08-05', TODAY)).toBe(0)
    expect(daysUntil('2026-08-15', TODAY)).toBe(10)
    expect(daysUntil('2026-08-01', TODAY)).toBe(-4)
  })

  it('missing when there is no document', () => {
    expect(slotState(undefined, TODAY)).toBe('MISSING')
  })

  it('a document with no expiration (a photo) is valid', () => {
    expect(slotState({ expirationDate: null }, TODAY)).toBe('VALID')
  })

  it('expiring within 30 days, expired past the date', () => {
    expect(slotState({ expirationDate: '2026-12-01' }, TODAY)).toBe('VALID')
    expect(slotState({ expirationDate: '2026-08-20' }, TODAY)).toBe('EXPIRING_SOON')
    expect(slotState({ expirationDate: '2026-09-04' }, TODAY)).toBe('EXPIRING_SOON') // day 30
    expect(slotState({ expirationDate: '2026-09-05' }, TODAY)).toBe('VALID')         // day 31
    expect(slotState({ expirationDate: '2026-08-04' }, TODAY)).toBe('EXPIRED')
  })
})

describe('ready score', () => {
  it('is all-missing for an entity with nothing on file', () => {
    const s = readyScore(TRUCK_FILE_SLOTS, new Map(), TODAY)
    expect(s.required).toBe(7)
    expect(s.onFile).toBe(0)
    expect(s.missing).toBe(7)
    expect(s.attention).toBe(0)
  })

  it('counts documents on file and flags the ones needing attention', () => {
    const docs = new Map<string, { expirationDate?: string | null }>([
      ['insurance_cert', { expirationDate: '2026-08-10' }],  // expiring soon
      ['irp_cab_card',   { expirationDate: '2026-01-01' }],  // expired
      ['photo_front',    { expirationDate: null }],          // fine
    ])
    const s = readyScore(TRUCK_FILE_SLOTS, docs, TODAY)
    expect(s.onFile).toBe(3)
    expect(s.missing).toBe(4)
    expect(s.attention).toBe(2)
  })

  it('a fully documented truck has no gaps', () => {
    const docs = new Map(TRUCK_FILE_SLOTS.map((s) => [s.key, { expirationDate: null }]))
    const s = readyScore(TRUCK_FILE_SLOTS, docs, TODAY)
    expect(s.onFile).toBe(s.required)
    expect(s.missing).toBe(0)
    expect(s.attention).toBe(0)
  })
})
