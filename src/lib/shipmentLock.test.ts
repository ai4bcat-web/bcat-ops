import { describe, expect, it } from 'vitest'
import { lockHeldByOther } from './shipmentLock'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const row = { editLockUserId: 'dee@bcatcorp.com', editLockUserName: 'Dee', editLockExpiresAt: '2026-11-10T12:05:00Z' }

describe('lockHeldByOther', () => {
  it('names the holder while the lock is live', () => {
    expect(lockHeldByOther(row, 'ryne@bcatcorp.com', NOW)).toEqual({ by: 'Dee', until: '2026-11-10T12:05:00Z' })
  })
  it('is free when it is mine, expired or absent', () => {
    expect(lockHeldByOther(row, 'DEE@bcatcorp.com', NOW)).toBeNull()
    expect(lockHeldByOther({ ...row, editLockExpiresAt: '2026-11-10T11:59:00Z' }, 'ryne@bcatcorp.com', NOW)).toBeNull()
    expect(lockHeldByOther({}, 'ryne@bcatcorp.com', NOW)).toBeNull()
  })
})
