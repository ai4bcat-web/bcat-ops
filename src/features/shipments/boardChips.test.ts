import { describe, expect, it } from 'vitest'
import { BOARD_FLAGS, BOARD_FLAG_LABELS, flagCounts, matchesFlags, needsSalesRep, type BoardFlag } from './boardChips'
import type { ShipmentRow } from './shipmentViews'

const NOW = Date.parse('2026-11-04T12:00:00Z')

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return { id, number: id, revDivision: 'DRY', salesRepId: 'rep', reference: 'PO', docsMissing: [], ...patch } as ShipmentRow
}

describe('board chips', () => {
  it('has no Open exceptions chip and ends with Check call overdue', () => {
    const labels = BOARD_FLAGS.map((f) => BOARD_FLAG_LABELS[f])
    expect(labels).not.toContain('Open exceptions')
    expect(labels).toEqual([
      'Missing reference #',
      'Needs sales rep',
      'Missing rev division',
      'Missing documents',
      'Review billing',
      'Check call overdue',
    ])
  })

  it('counts each chip over the rows it is given', () => {
    const rows = [
      row('a'),
      row('b', { reference: null }),
      row('c', { salesRepId: null, revDivision: null }),
      row('d', { reference: null, salesRepId: null, docsMissing: ['POD'] }),
      row('e', { nextCheckCallAt: '2026-11-04T10:00:00Z' }),
    ]
    expect(flagCounts(rows, NOW)).toEqual({
      missingReference: 2,
      missingSalesRep: 2,
      missingRevDivision: 1,
      docsMissing: 1,
      reviewBilling: 0,
      checkCallOverdue: 1,
    })
  })

  it('Review billing flags pre-cutover shipments still in Docs needed, never a new one or one past that rung', () => {
    const old = row('o', { arStatus: 'DOCS_NEEDED', legacyImported: true })
    const original = row('p', { arStatus: 'DOCS_NEEDED', source: 'BACKFILL' })
    const fresh = row('q', { arStatus: 'DOCS_NEEDED', source: 'MANUAL' })
    const billed = row('r', { arStatus: 'UNPAID', legacyImported: true })
    expect(flagCounts([old, original, fresh, billed], NOW).reviewBilling).toBe(2)
    expect(matchesFlags(fresh, new Set<BoardFlag>(['reviewBilling']), NOW)).toBe(false)
  })

  it('pressed chips narrow together (a row must miss every pressed thing)', () => {
    const both = row('x', { reference: null, salesRepId: null })
    const one = row('y', { reference: null })
    const pressed = new Set<BoardFlag>(['missingReference', 'missingSalesRep'])
    expect(matchesFlags(both, pressed, NOW)).toBe(true)
    expect(matchesFlags(one, pressed, NOW)).toBe(false)
  })

  it('Needs sales rep reads salesRepId OR salesRepCode: a name kept as text is a rep, blanks are not', () => {
    expect(needsSalesRep({ salesRepId: null, salesRepCode: null })).toBe(true)
    expect(needsSalesRep({ salesRepId: '', salesRepCode: '  ' })).toBe(true)
    expect(needsSalesRep({ salesRepId: undefined, salesRepCode: undefined })).toBe(true)
    expect(needsSalesRep({ salesRepId: null, salesRepCode: 'BCAT' })).toBe(false)
    expect(needsSalesRep({ salesRepId: 'u-ryne', salesRepCode: null })).toBe(false)
    const rows = [row('a', { salesRepId: null, salesRepCode: 'PERLA LOPEZ' }), row('b', { salesRepId: null }), row('c', { salesRepId: null, salesRepCode: null })]
    expect(flagCounts(rows, NOW).missingSalesRep).toBe(2)
  })
  it('matches the waiting-for-detention and waiting-for-TONU flags on the stored flag only, each on its own', () => {
    const stamp = { flaggedAt: '2026-11-16T10:00:00.000Z', flaggedBy: 'a@b.c' }
    const det = row('d', { detentionFlag: { stopType: 'pickup', ...stamp } })
    const ton = row('t', { tonuFlag: { amount: 250, ...stamp } })
    const both = row('b', { detentionFlag: { stopType: 'delivery', ...stamp }, tonuFlag: { ...stamp } })
    const none = row('n')
    const only = (flag: BoardFlag) => [det, ton, both, none].filter((r) => matchesFlags(r, new Set([flag]), NOW)).map((r) => r.id)
    expect(only('detention')).toEqual(['d', 'b'])
    expect(only('tonu')).toEqual(['t', 'b'])
    expect(BOARD_FLAG_LABELS.tonu).toBe('TONU')
  })
  it('matches the to-void flag on the stored flag only, and a flagged shipment still counts as live', () => {
    const stamp = { flaggedAt: '2026-11-18T10:00:00.000Z', flaggedBy: 'a@b.c' }
    const flagged = row('v', { toVoidFlag: { reason: 'Duplicate of 14872', ...stamp } })
    const tonu = row('t', { tonuFlag: { ...stamp } })
    const none = row('n')
    const only = (flag: BoardFlag) => [flagged, tonu, none].filter((r) => matchesFlags(r, new Set([flag]), NOW)).map((r) => r.id)
    expect(only('toVoid')).toEqual(['v'])
    expect(only('tonu')).toEqual(['t'])
    expect(BOARD_FLAG_LABELS.toVoid).toBe('To void')
  })
})
