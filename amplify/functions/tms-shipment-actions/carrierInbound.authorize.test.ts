/** Who may call the Step AL router actions: the system-caller door is narrow and never admin. */
import { describe, it, expect } from 'vitest'

import { authorize, SYSTEM_CALLERS } from './handler'

describe('carrier-inbox system caller', () => {
  it('may file inbound offers without a user, as a non-admin system identity', async () => {
    const caller = await authorize('FILE_INBOUND_OFFER', null, 'carrier-inbox')
    expect(caller).toMatchObject({ email: 'system@bcatcorp.com', isAdmin: false, groups: [] })
  })

  it('may call nothing else', async () => {
    expect(SYSTEM_CALLERS['carrier-inbox']).toEqual(['FILE_INBOUND_OFFER'])
    await expect(authorize('ASSIGN_INBOUND_OFFER', null, 'carrier-inbox')).rejects.toThrow('Unauthorized')
    await expect(authorize('RECORD_CARRIER_OFFER', null, 'carrier-inbox')).rejects.toThrow('Unauthorized')
  })

  it('an unknown system caller gets nothing', async () => {
    await expect(authorize('FILE_INBOUND_OFFER', null, 'someone-else')).rejects.toThrow('Forbidden')
  })

  it('a signed-in admin cannot call the filing action', async () => {
    const identity = { sub: 'u1', username: 'ryne', claims: { email: 'ryne@bcatcorp.com', 'cognito:groups': ['ADMIN'] } }
    await expect(authorize('FILE_INBOUND_OFFER', identity as never)).rejects.toThrow('Forbidden')
  })

  it('reps with the loads page may assign and dismiss', async () => {
    const identity = { sub: 'u2', username: 'rep', claims: { email: 'rep@bcatcorp.com', 'cognito:groups': ['page-loads'] } }
    await expect(authorize('ASSIGN_INBOUND_OFFER', identity as never)).resolves.toMatchObject({ email: 'rep@bcatcorp.com' })
    await expect(authorize('DISMISS_INBOUND_OFFER', identity as never)).resolves.toBeTruthy()
  })

  it('a user with no relevant page key may not assign', async () => {
    const identity = { sub: 'u3', username: 'x', claims: { email: 'x@bcatcorp.com', 'cognito:groups': ['page-crm'] } }
    await expect(authorize('ASSIGN_INBOUND_OFFER', identity as never)).rejects.toThrow('Forbidden')
  })
})
