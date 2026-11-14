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

  it('N/A where the document is not chased: car shipping has neither, own fleet has no carrier RC', () => {
    expect(docCellOf(row({ revDivision: 'CAR_SHIPPING' }), 'POD')).toBe('NA')
    expect(docCellOf(row({ revDivision: 'ASSETS' }), 'RATE_CON')).toBe('NA')
    expect(docCellOf(row({ revDivision: 'ASSETS' }), 'POD')).toBe('MISSING')
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
