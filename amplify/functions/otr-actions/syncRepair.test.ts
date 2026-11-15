import { describe, expect, it, vi } from 'vitest'

vi.mock('../_shared/otrClient', () => ({ OtrClient: class {}, OtrError: class extends Error {}, OTR_STAGING_BASE: '' }))

import { needsFactoredRepair } from './sync'

describe('needsFactoredRepair', () => {
  it('repairs an Approved row still shown as waiting or short a document', () => {
    expect(needsFactoredRepair({ otrStatus: 3, status: 'PENDING_WITH_OTR' })).toBe(true)
    expect(needsFactoredRepair({ otrStatus: '3', status: 'NEED_TO_FACTOR' })).toBe(true)
  })
  it('leaves Dead, Duplicate, already-factored and manual rows alone', () => {
    expect(needsFactoredRepair({ otrStatus: 4, status: 'PENDING_WITH_OTR' })).toBe(false)
    expect(needsFactoredRepair({ otrStatus: 7, status: 'PENDING_WITH_OTR' })).toBe(false)
    expect(needsFactoredRepair({ otrStatus: 3, status: 'FACTORED' })).toBe(false)
    expect(needsFactoredRepair({ otrStatus: 3, status: 'MANUAL_INVOICE' })).toBe(false)
  })
})
