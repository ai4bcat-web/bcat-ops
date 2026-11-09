import { describe, expect, it } from 'vitest'
import { classifyLinkCandidates, linkKeyForLoad, linkKeyForShipmentNumber, linkReportCsv, type LinkInput } from './shipmentLink'

describe('link keys', () => {
  it('agrees across padded, Pro#-labelled and plain spellings of one PRO', () => {
    expect(linkKeyForLoad('14452  ')).toBe('14452')
    expect(linkKeyForLoad('Pro# 14452')).toBe('14452')
    expect(linkKeyForShipmentNumber('14452')).toBe('14452')
  })

  it('never strips leading zeros', () => {
    expect(linkKeyForLoad('00123')).toBe('00123')
    expect(linkKeyForShipmentNumber('00123')).not.toBe(linkKeyForShipmentNumber('123'))
  })

  it('removes exactly one leading L from a shipment number, only when 3+ characters remain', () => {
    expect(linkKeyForShipmentNumber('L14913')).toBe('14913')
    expect(linkKeyForShipmentNumber('LL14913')).toBe('L14913')
    expect(linkKeyForShipmentNumber('L12')).toBe('L12')
  })

  it('gives the renumbered digits-only shipment and its old L<pro> spelling (padded or labelled) the same key as the Load', () => {
    const key = linkKeyForLoad('14334  ')
    expect(key).toBe('14334')
    for (const number of ['14334', 'L14334', 'L14334  ', 'LPro# 14334']) expect(linkKeyForShipmentNumber(number)).toBe(key)
  })

  it('gives counter shapes no PRO identity', () => {
    expect(linkKeyForShipmentNumber('S000123-1')).toBeNull()
    expect(linkKeyForShipmentNumber('X000123-2', 'X')).toBeNull()
    expect(linkKeyForShipmentNumber('')).toBeNull()
    expect(linkKeyForShipmentNumber('N/A')).toBeNull()
  })
})

const base = (over: Partial<LinkInput>): LinkInput => ({ loads: [], shipments: [], claims: [], exportKeys: new Set(), ...over })

describe('classifyLinkCandidates', () => {
  it('puts each Load in exactly one bucket and the buckets add up to the Load count', () => {
    const report = classifyLinkCandidates(
      base({
        loads: [
          { id: 'l1', aljexId: '10001  ' },
          { id: 'l2', aljexId: 'Pro# 10002' },
          { id: 'l3', aljexId: '10003' },
          { id: 'l4', aljexId: '' },
          { id: 'l5', aljexId: '10005', shipmentId: 'shp-5' },
          { id: 'l6', aljexId: '10006' },
        ],
        exportKeys: new Set(['10001', '10002', '10006']),
        backfillSkips: new Map([['l6', 'SHIPMENT_VOIDED']]),
      }),
    )
    expect(report.matchedByPro.map((e) => e.loadId)).toEqual(['l1', 'l2', 'l6'])
    expect(report.linkedById.map((e) => [e.loadId, e.reason])).toEqual([
      ['l3', 'NOT_IN_EXPORT'],
      ['l4', 'NO_PRO'],
    ])
    expect(report.alreadyLinked.map((e) => e.loadId)).toEqual(['l5'])
    // l6 is in the export, so it links by PRO; a backfill skip only matters for the ID fallback.
    const c = report.counts
    expect(c.matchedByPro + c.linkedById + c.ambiguous + c.unmappable + c.alreadyLinked).toBe(c.loads)
  })

  it('reports a Load the ID fallback refuses as unmappable, or ambiguous when another Load holds the PRO', () => {
    const report = classifyLinkCandidates(
      base({
        loads: [
          { id: 'a', aljexId: '' },
          { id: 'b', aljexId: '20002' },
          { id: 'c', aljexId: '20003' },
        ],
        backfillSkips: new Map([
          ['a', 'NO_USABLE_DATA'],
          ['b', 'SHIPMENT_VOIDED'],
          ['c', 'PRO_CLAIMED_BY_OTHER_LOAD'],
        ]),
      }),
    )
    expect(report.unmappable.map((e) => e.loadId)).toEqual(['a', 'b'])
    expect(report.ambiguous.map((e) => [e.loadId, e.reason])).toEqual([['c', 'PRO_CLAIMED_BY_OTHER_LOAD']])
  })

  it('never guesses: duplicates, several shipments, an unlinked shipment and a foreign claim are all ambiguous', () => {
    const report = classifyLinkCandidates(
      base({
        loads: [
          { id: 'd1', aljexId: '30001' },
          { id: 'd2', aljexId: '30001 ' },
          { id: 'm', aljexId: '30002' },
          { id: 'u', aljexId: '30003' },
          { id: 'f', aljexId: '30004' },
          { id: 'ok', aljexId: '30005' },
        ],
        shipments: [
          { id: 's1', number: '30002' },
          { id: 's2', number: 'L30002' },
          { id: 's3', number: '30003' },
        ],
        claims: [
          { id: '30004', loadId: 'someone-else' },
          { id: '30005', loadId: 'ok' },
        ],
        exportKeys: new Set(['30001', '30002', '30003', '30004', '30005']),
      }),
    )
    expect(Object.fromEntries(report.ambiguous.map((e) => [e.loadId, e.reason]))).toEqual({
      d1: 'DUPLICATE_LOAD_PRO',
      d2: 'DUPLICATE_LOAD_PRO',
      m: 'MULTIPLE_SHIPMENTS',
      u: 'SHIPMENT_NOT_LINKED',
      f: 'PRO_CLAIMED_BY_OTHER_LOAD',
    })
    expect(report.matchedByPro.map((e) => e.loadId)).toEqual(['ok'])
  })

  it('is idempotent: once every Load carries a shipmentId nothing is left to link', () => {
    const report = classifyLinkCandidates(
      base({ loads: [{ id: 'x', aljexId: '40001', shipmentId: 's' }], exportKeys: new Set(['40001']) }),
    )
    expect(report.counts).toMatchObject({ matchedByPro: 0, linkedById: 0, ambiguous: 0, unmappable: 0, alreadyLinked: 1, loads: 1 })
  })

  it('writes a CSV with one row per Load and no cell values beyond ids and PROs', () => {
    const csv = linkReportCsv(classifyLinkCandidates(base({ loads: [{ id: 'l1', aljexId: '50001' }], exportKeys: new Set(['50001']) })))
    expect(csv.split('\n')).toEqual(['load_id,pro,bucket,reason,detail', 'l1,50001,MATCHED_BY_PRO,,', ''])
  })
})
