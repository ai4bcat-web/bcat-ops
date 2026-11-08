import { describe, expect, it } from 'vitest'
import { SYNTHETIC_EIN } from '@/test/syntheticTaxIds'
import type { CarrierRow } from './carrierViews'
import { carrierGridColumns, carriersToCsv } from './carrierGridColumns'

describe('carrier CSV export', () => {
  it('carries no tax-ID column or value, even for a carrier with a tax ID on file', () => {
    const columns = carrierGridColumns('2026-11-07T00:00:00.000Z')
    const row = {
      id: 'k1', name: 'Fake Haul LLC', type: 'TL', status: 'ACTIVE', mcNumber: 'MC900001',
      taxIdLast4: '0001', taxIdType: 'EIN', taxIdOnFileAt: '2026-11-10T00:00:00Z', einNumber: SYNTHETIC_EIN,
      createdBy: 't', updatedBy: 't', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as CarrierRow
    const csv = carriersToCsv([row], columns)
    expect(csv).toContain('Fake Haul LLC')
    expect(csv.split('\n')[0]).not.toMatch(/tax|ein|ssn|fed/i)
    expect(csv).not.toContain(SYNTHETIC_EIN)
    expect(csv).not.toContain('2026-11-10')
    expect(columns.map((c) => c.key)).not.toContainEqual(expect.stringMatching(/tax|ein|ssn/i))
  })
})
