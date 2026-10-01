// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type jsPDF from 'jspdf'
import { buildPayStatementPdf } from './payPdf'
import { buildBoxTruckPayStatementPdf } from './payPdfBoxTruck'
import { FACTORING_FEE_LABEL, type DriverPayStatement } from './driverPay'
import type { DriverPayRow } from '@/hooks/useAmazonPay'
import type { BoxTruckPayRow } from '@/hooks/useBoxTruckPay'
import type { Driver } from '@/types'
import type { DriverPaySetting } from '@/lib/apiClient'

// jsdom never fetches images: a real <img> fires neither load nor error, so the logo
// await would hang. Fail the load instead — the builders fall back to the wordmark.
beforeAll(() => {
  class OfflineImage {
    onload: (() => void) | null = null
    onerror: ((err?: unknown) => void) | null = null
    crossOrigin: string | null = null
    width = 120
    height = 40
    set src(_value: string) {
      setTimeout(() => this.onerror?.(new Error('images are not loaded in tests')), 0)
    }
  }
  vi.stubGlobal('Image', OfflineImage)
})

/** Every string the document actually draws, in draw order, read back out of the
 *  page content streams (`(text) Tj`, with PDF paren escapes undone). */
function drawnStrings(doc: jsPDF): string[] {
  const stream = (doc as unknown as { internal: { pages: string[][] } }).internal.pages.flat().join('\n')
  return [...stream.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1'))
}

const driver = { id: 'd1', name: 'Zero Week', active: true, colorKey: 'driver-1' } as Driver
const setting = { id: 's1', driverId: 'd1', payPercent: 0.42, expensesBeforePercent: true } as DriverPaySetting

const emptyStatement: DriverPayStatement = {
  gross: 0, payPercent: 0.42, expensesBeforePercent: true, driverAmount: 0,
  totalDeductions: 0, factoringFee: 0, subtotal: 0, totalCredits: 0, totalDebits: 0,
  payBeforeCredits: 0, checkAmount: 0,
} as DriverPayStatement

const amazonRow = {
  driver, setting, baseSetting: setting, trips: [], fuel: 0, fuelTxns: [],
  deductions: [], oneOffs: [], credits: [], debits: [], fixedDebits: [],
  statement: emptyStatement, duplicateTripIds: new Set<string>(),
} as DriverPayRow

const boxRow = {
  driver, setting, trips: [], fuel: 0, fuelTxns: [],
  deductions: [], oneOffs: [], credits: [], debits: [], fixedDebits: [],
  statement: emptyStatement, unpulledLoadCount: 0,
} as BoxTruckPayRow

describe('pay statement PDFs', () => {
  it('prints the factoring fee at $0.00 on an Amazon week with no trips', async () => {
    const drawn = drawnStrings(await buildPayStatementPdf(amazonRow, '2026-09-20'))
    const at = drawn.indexOf(FACTORING_FEE_LABEL)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(drawn[at + 1]).toBe('($0.00)')
    expect(drawn).not.toContain('No deductions.')
  })

  it('prints the factoring fee at $0.00 on a box-truck period with no shipments', async () => {
    const drawn = drawnStrings(await buildBoxTruckPayStatementPdf(boxRow, '2026-09-20'))
    const at = drawn.indexOf(FACTORING_FEE_LABEL)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(drawn[at + 1]).toBe('($0.00)')
  })

  it('still prints the fee when the week was paid', async () => {
    const paid = { ...amazonRow, statement: { ...emptyStatement, gross: 1000, factoringFee: 20, totalDeductions: 20 } } as DriverPayRow
    const drawn = drawnStrings(await buildPayStatementPdf(paid, '2026-09-20'))
    const at = drawn.indexOf(FACTORING_FEE_LABEL)
    expect(drawn[at + 1]).toBe('($20.00)')
  })
})
