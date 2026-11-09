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
      checkCallOverdue: 1,
    })
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
})
