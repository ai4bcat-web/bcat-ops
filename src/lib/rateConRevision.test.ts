import { describe, expect, it } from 'vitest'
import {
  parseRateConSnapshot, rateConChanges, rateConRevisionFor, rateConSnapshotOf, rateConThreadHeaders, revisedRateConSubject, withRateConHistory,
  type RateConSnapshot,
} from './rateConRevision'
import type { RateConInput } from './carrierRateCon'

const input = (over: Partial<RateConInput> = {}): RateConInput => ({
  carrier: { name: 'Landstar Ranger', mcNumber: '166960', dotNumber: '241572', phone: null },
  loadCarrier: { truckNumber: '30', trailerNumber: '06', driverName: 'Roberto', driverPhone: null },
  loadNumber: '20057',
  equipmentType: 'FLATBED',
  commodity: 'ENGINES',
  weightLbs: 37000,
  miles: 187,
  pieces: null,
  stops: [
    { kind: 'PICKUP', name: 'Whimsy Intermodal', city: 'Chicago', state: 'IL', apptAt: '2026-11-16T13:00:00.000Z' },
    { kind: 'DELIVERY', name: 'Generac', city: 'Oshkosh', state: 'WI', apptAt: '2026-11-16T14:00:00.000Z', apptEnd: '2026-11-16T20:00:00.000Z', apptType: 'fcfs' },
  ],
  charges: [{ label: 'Linehaul', amountCents: 120000 }],
  totalCents: 120000,
  notes: '',
  ...over,
})

describe('rateConChanges', () => {
  it('lists added accessorials, moved appointments and the new total', () => {
    const prev = rateConSnapshotOf(input())
    const next = rateConSnapshotOf(input({
      charges: [{ label: 'Linehaul', amountCents: 120000 }, { label: 'Detention', amountCents: 7500 }],
      totalCents: 127500,
      stops: [
        { kind: 'PICKUP', name: 'Whimsy Intermodal', city: 'Chicago', state: 'IL', apptAt: '2026-11-17T13:00:00.000Z' },
        { kind: 'DELIVERY', name: 'Generac', city: 'Oshkosh', state: 'WI', apptAt: '2026-11-16T14:00:00.000Z', apptEnd: '2026-11-16T20:00:00.000Z', apptType: 'fcfs' },
      ],
    }))
    expect(rateConChanges(prev, next)).toEqual([
      'Added DETENTION $75.00',
      'Total rate $1,200.00 -> $1,275.00',
      'Pick 1 appointment 11/16 07:00 -> 11/17 07:00',
    ])
  })

  it('is empty when nothing the carrier sees moved', () => {
    expect(rateConChanges(rateConSnapshotOf(input()), rateConSnapshotOf(input()))).toEqual([])
  })

  it('reports removed and re-priced lines and equipment', () => {
    const prev = rateConSnapshotOf(input({ charges: [{ label: 'Linehaul', amountCents: 120000 }, { label: 'Fuel', amountCents: 5000 }], totalCents: 125000 }))
    const next = rateConSnapshotOf(input({ charges: [{ label: 'Linehaul', amountCents: 130000 }], totalCents: 130000, equipmentType: 'STEPDECK' }))
    expect(rateConChanges(prev, next)).toEqual([
      'LINEHAUL $1,200.00 -> $1,300.00',
      'Removed FUEL $50.00',
      'Total rate $1,250.00 -> $1,300.00',
      'Equipment FLATBED -> STEPDECK',
    ])
  })
})

describe('rateConRevisionFor', () => {
  it('is null on a first send and numbers later ones', () => {
    const snap = rateConSnapshotOf(input())
    expect(rateConRevisionFor(1, null, snap)).toBeNull()
    expect(rateConRevisionFor(2, snap, snap)).toMatchObject({ number: 2, changes: [] })
    expect(rateConRevisionFor(3, null, snap)).toMatchObject({ number: 3, changes: [] })
  })
})

describe('withRateConHistory', () => {
  const snap = (changes: string[]) => ({ charges: [], totalCents: 0, stops: [], equipmentType: null, commodity: null, weightLbs: null, pieces: null, miles: null, notes: '', truckNumber: null, trailerNumber: null, driverName: null, changes })

  it('appends this version to the stored log and ignores any history the browser sent', () => {
    const stored = { ...snap(['x']), history: [{ version: 2, at: '2026-11-13T21:00:00Z', by: 'a@b.com', changes: ['Driver none -> Pat'] }] }
    const browser = { ...snap(['Truck # 01 -> 02']), history: [{ version: 9, at: 'forged', by: null, changes: ['forged'] }] }
    const out = withRateConHistory(browser, stored, 3, '2026-11-17T18:30:00Z', 'ryne@bcatcorp.com')
    expect(out.history?.map((h) => h.version)).toEqual([2, 3])
    expect(out.history?.[1]).toEqual({ version: 3, at: '2026-11-17T18:30:00Z', by: 'ryne@bcatcorp.com', changes: ['Truck # 01 -> 02'] })
  })

  it('a first send logs nothing and a re-stored version replaces its own entry', () => {
    expect(withRateConHistory(snap([]), null, 1, 't', null).history).toEqual([])
    const stored = { ...snap([]), history: [{ version: 2, at: 'old', by: null, changes: ['old'] }] }
    expect(withRateConHistory(snap(['new']), stored, 2, 'now', null).history).toEqual([{ version: 2, at: 'now', by: null, changes: ['new'] }])
  })
})

describe('rateConThreadHeaders', () => {
  const row = (over: Record<string, unknown>) => ({ kind: 'RATE_CON', direction: 'OUT', loadCarrierId: 'lc-1', status: 'SENT', ...over })
  it('replies to the last rate con on this assignment and references back to the first', () => {
    const headers = rateConThreadHeaders([
      row({ messageId: '<b@ses>', at: '2026-11-13T02:00:00Z', subject: 'RE: Rate confirmation — load 20057 [S-1]' }),
      row({ messageId: '<a@ses>', at: '2026-11-13T01:00:00Z', subject: 'Rate confirmation — load 20057 [S-1]' }),
      row({ messageId: '<other@ses>', at: '2026-11-13T03:00:00Z', loadCarrierId: 'lc-2' }),
      row({ messageId: '<failed@ses>', at: '2026-11-13T04:00:00Z', status: 'NOT_SENT' }),
      { kind: 'OTHER', direction: 'OUT', loadCarrierId: 'lc-1', status: 'SENT', messageId: '<bol@ses>', at: '2026-11-13T05:00:00Z' },
    ], 'lc-1')
    expect(headers).toEqual({ inReplyTo: '<b@ses>', references: '<a@ses> <b@ses>', originalSubject: 'Rate confirmation — load 20057 [S-1]' })
    expect(revisedRateConSubject(headers!.originalSubject)).toBe('RE: Rate confirmation — load 20057 [S-1]')
  })

  it('is null when nothing was sent before', () => {
    expect(rateConThreadHeaders([], 'lc-1')).toBeNull()
  })
})

describe('parseRateConSnapshot', () => {
  it('accepts a stored JSON string and trims the change lines', () => {
    const snap: RateConSnapshot = { ...rateConSnapshotOf(input()), changes: ['a\r\nb'] }
    expect(parseRateConSnapshot(JSON.stringify(snap))?.changes).toEqual(['a b'])
  })
  it('refuses junk', () => {
    expect(parseRateConSnapshot('nope')).toBeNull()
    expect(parseRateConSnapshot({ charges: 'x' })).toBeNull()
    expect(parseRateConSnapshot('x'.repeat(30_000))).toBeNull()
  })
})
