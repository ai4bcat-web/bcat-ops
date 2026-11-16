import { describe, it, expect } from 'vitest'
import { docCellOf, docsMissingOf, rateConIn } from './shipmentViews'

/** A delivered brokerage row whose order gate requires the POD and the rate confirmation. */
const row = (over: Record<string, unknown> = {}) => ({
  status: 'DELIVERED', voidedAt: null, deletedAt: null, assignmentType: 'CARRIER', revDivision: 'BROKERAGE',
  docsRequired: ['POD', 'RATE_CON'], docsMissing: ['POD', 'RATE_CON'], docsOverrideAt: null,
  rateConSignedAt: null, rateConStatus: null, rateConOnFile: null, ...over,
}) as never

describe('POD / RC board cells read the same gate as the Documents boxes', () => {
  it('both missing until the boxes hold them', () => {
    expect(docCellOf(row(), 'POD')).toBe('MISSING')
    expect(docCellOf(row(), 'RATE_CON')).toBe('MISSING')
  })

  it('retyping a file into a POD (the gate re-caches without POD) flips the POD cell; deleting it flips it back', () => {
    const retyped = row({ docsMissing: ['RATE_CON'] })
    expect(docCellOf(retyped, 'POD')).toBe('PRESENT')
    expect(docCellOf(retyped, 'RATE_CON')).toBe('MISSING')
    const deleted = row({ docsMissing: ['POD', 'RATE_CON'] })
    expect(docCellOf(deleted, 'POD')).toBe('MISSING')
  })

  it('a rate con in the box counts even with no signature or legacy key', () => {
    const r = row({ docsMissing: ['POD'] })
    expect(rateConIn(r)).toBe(true)
    expect(docCellOf(r, 'RATE_CON')).toBe('PRESENT')
  })

  it('N/A where the document is not chased: car shipping has neither', () => {
    expect(docCellOf(row({ revDivision: 'CAR_SHIPPING' }), 'POD')).toBe('NA')
    expect(docCellOf(row({ revDivision: 'ASSETS' }), 'POD')).toBe('MISSING')
  })

  it('own fleet needs the outside rate con (Ryne 2026-11-16), unless the customer waives it', () => {
    expect(docCellOf(row({ revDivision: 'ASSETS' }), 'RATE_CON')).toBe('MISSING')
    expect(docCellOf(row({ revDivision: 'ASSETS', rateConOnFile: true }), 'RATE_CON')).toBe('PRESENT')
    expect(docCellOf(row({ revDivision: 'ASSETS', docsNotRequired: ['RATE_CON'] }), 'RATE_CON')).toBe('NA')
  })

  it('not delivered and the gate never ran: nothing to say yet', () => {
    expect(docCellOf(row({ status: 'DISPATCHED', docsMissing: null }), 'POD')).toBe('')
  })

  it('the Missing docs count names the rate con once', () => {
    expect(docsMissingOf(row())).toEqual(['POD', 'RATE_CON'])
    expect(docsMissingOf(row({ docsMissing: [] }))).toEqual([])
  })

  it('a POD on file shows present even when the customer list does not require one (the gate\'s present list)', () => {
    const r = row({ docsRequired: ['RATE_CON'], docsMissing: [], docsPresent: ['POD', 'RATE_CON'] })
    expect(docCellOf(r, 'POD')).toBe('PRESENT')
    expect(docCellOf(r, 'RATE_CON')).toBe('PRESENT')
    expect(docsMissingOf(r)).toEqual([])
    // Deleting it: the gate re-caches without POD in its present list, and a delivered load is missing one again.
    const gone = row({ docsRequired: ['RATE_CON'], docsMissing: [], docsPresent: ['RATE_CON'] })
    expect(docCellOf(gone, 'POD')).toBe('MISSING')
  })
})

describe('MISSING chip counts the documents OTR or own fleet needs (Ryne 2026-11-16)', () => {
  it('a factored load with no rate con counts it, and lists it', async () => {
    const { factorInfoText, factorInfoTitle, openMissingDocs } = await import('./shipmentViews')
    const factored = { ...(row({ docsMissing: ['RATE_CON'], docsPresent: ['POD'] }) as object), id: 's1', customerFactors: true, factorGaps: [] } as never
    expect(openMissingDocs(factored)).toEqual(['RATE_CON'])
    expect(factorInfoText(factored)).toBe('Missing 1')
    expect(factorInfoTitle(factored)).toBe('Missing document: Rate con')
  })
  it('an own-fleet load with no outside rate con counts it; a waived customer does not', async () => {
    const { openMissingDocs } = await import('./shipmentViews')
    const own = { ...(row({ revDivision: 'ASSETS', docsMissing: ['RATE_CON'], docsPresent: ['POD'] }) as object), id: 's2' } as never
    expect(openMissingDocs(own)).toEqual(['RATE_CON'])
    expect(openMissingDocs({ ...(own as object), docsNotRequired: ['RATE_CON'] } as never)).toEqual([])
  })
  it('a brokerage load for a customer that does not factor is not counted', async () => {
    const { openMissingDocs } = await import('./shipmentViews')
    expect(openMissingDocs({ ...(row() as object), id: 's3', customerFactors: false } as never)).toEqual([])
  })
})
