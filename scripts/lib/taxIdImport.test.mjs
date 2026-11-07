import { describe, expect, it, vi } from 'vitest'
import { SYNTHETIC_EINS, SYNTHETIC_SSNS } from '../../src/test/syntheticTaxIds'
import { BATCH_SIZE, runTaxIdImport, shapeOf, syntheticTaxId } from './taxIdImport.mjs'

const HEADER = 'Vendor Name,Aljex Carrier ID,Fed/SS #,Bank Account,Routing #,MC #,DOT #\r\n'
const csv = (rows) => HEADER + rows.map((r) => r.join(',')).join('\r\n') + '\r\n'
const row = (i, tax, mc = `MC${900000 + i}`) => [`Carrier ${i}`, `A${i}`, tax, 'BANK-CANARY', 'ROUTE-CANARY', mc, `${7000000 + i}`]
const chunksOf = (text, size = 97) => (function* () { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size) })()

const ok = (rows) => ({ set: rows.length, unchanged: 0, duplicates: [], invalidFormat: 0, unmatched: [] })

describe('shapeOf / syntheticTaxId', () => {
  it('classifies by punctuation only', () => {
    expect(shapeOf(SYNTHETIC_EINS[0])).toBe('EIN')
    expect(shapeOf(SYNTHETIC_SSNS[0])).toBe('SSN')
    expect(shapeOf('garbage')).toBe('OTHER')
    expect(shapeOf('  ')).toBe('EMPTY')
  })

  it('is deterministic per carrier and always IRS-impossible', () => {
    expect(syntheticTaxId('A1', 'EIN')).toBe(syntheticTaxId('A1', 'EIN'))
    expect(syntheticTaxId('A1', 'EIN')).not.toBe(syntheticTaxId('A2', 'EIN'))
    expect(syntheticTaxId('A1', 'EIN')).toMatch(/^00-\d{7}$/)
    expect(syntheticTaxId('A1', 'SSN')).toMatch(/^000-\d{2}-\d{4}$/)
  })
})

describe('runTaxIdImport', () => {
  it('dry run invokes nothing and returns only counts, resolved against the carrier index', async () => {
    const invoke = vi.fn()
    const carriers = { byMc: new Map([['900001', 'k1']]), byDot: new Map([['7000002', 'k2']]), byAljex: new Map([['A3', 'k3']]) }
    const rows = [row(1, SYNTHETIC_EINS[0]), row(2, SYNTHETIC_SSNS[0], 'MC-x'), row(3, 'garbage', 'none'), row(4, ''), row(5, SYNTHETIC_EINS[1])]
    const out = await runTaxIdImport({ chunks: chunksOf(csv(rows)), production: false, apply: false, invoke, carriers })
    expect(invoke).not.toHaveBeenCalled()
    expect(out).toMatchObject({ rows: 5, withValue: 4, shapes: { EIN: 2, SSN: 1, OTHER: 1 }, resolvable: 3, unresolvable: 1, batches: 0 })
    const text = JSON.stringify(out)
    for (const v of [...SYNTHETIC_EINS, ...SYNTHETIC_SSNS, 'BANK-CANARY', 'ROUTE-CANARY']) expect(text).not.toContain(v)
  })

  it('batches 100 rows per invoke, never sends bank or routing, and substitutes synthetic IDs outside production', async () => {
    const batches = []
    const invoke = vi.fn(async (rows) => { batches.push(rows); return ok(rows) })
    const rows = Array.from({ length: 250 }, (_, i) => row(i, SYNTHETIC_EINS[i % SYNTHETIC_EINS.length]))
    const out = await runTaxIdImport({ chunks: chunksOf(csv(rows)), production: false, apply: true, invoke })
    expect(batches.map((b) => b.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 50])
    expect(out).toMatchObject({ rows: 250, withValue: 250, batches: 3, set: 250 })
    const sent = batches.flat()
    expect(Object.keys(sent[0]).sort()).toEqual(['aljexCarrierId', 'dotNumber', 'mcNumber', 'value'])
    for (const r of sent) expect(r.value).toBe(syntheticTaxId(r.aljexCarrierId, 'EIN'))
    expect(JSON.stringify(sent)).not.toMatch(/CANARY/)
    for (const v of SYNTHETIC_EINS) expect(JSON.stringify(sent)).not.toContain(v)
  })

  it('counts a malformed value as skipped outside production instead of sending it, and sums the Lambda counts', async () => {
    const invoke = vi.fn(async () => ({ set: 1, unchanged: 2, duplicates: [{ carrierId: 'a', duplicateOfCarrierId: 'b' }], invalidFormat: 3, unmatched: ['A9', 'A8'] }))
    const out = await runTaxIdImport({ chunks: chunksOf(csv([row(1, SYNTHETIC_EINS[0]), row(2, 'garbage')])), production: false, apply: true, invoke })
    expect(out).toMatchObject({ skippedInvalid: 1, set: 1, unchanged: 2, duplicates: 1, invalidFormat: 3, unmatched: 2, batches: 1 })
    expect(invoke.mock.calls[0][0]).toHaveLength(1)
  })

  it('a production run (not reachable from the CLI yet) sends the file value as is', async () => {
    const invoke = vi.fn(async (rows) => ok(rows))
    await runTaxIdImport({ chunks: chunksOf(csv([row(1, SYNTHETIC_SSNS[1])])), production: true, apply: true, invoke })
    expect(invoke.mock.calls[0][0][0].value).toBe(SYNTHETIC_SSNS[1])
  })

  it('refuses a file with no Fed/SS # column, without echoing anything from the file', async () => {
    await expect(runTaxIdImport({ chunks: ['Vendor Name,Aljex Carrier ID\r\nX,1\r\n'], production: false, apply: false })).rejects.toThrow('no "Fed/SS #" column')
  })

  it('an invoke failure leaves no value in the error', async () => {
    const invoke = async () => { throw new Error('IMPORT_TAX_IDS failed (Error)') }
    const err = await runTaxIdImport({ chunks: chunksOf(csv([row(1, SYNTHETIC_EINS[0])])), production: false, apply: true, invoke }).catch((e) => e)
    expect(String(err.message)).not.toContain(SYNTHETIC_EINS[0])
  })
})
