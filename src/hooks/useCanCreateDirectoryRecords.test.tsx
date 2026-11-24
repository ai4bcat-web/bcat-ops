// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const user = vi.hoisted(() => ({ current: null as null | { email: string; groups: string[] } }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => user.current }))

import { useCanCreateDirectoryRecords } from './useCanCreateDirectoryRecords'
import { useCanCreateCustomer } from '@/features/shipments/components/useCanCreateCustomer'

describe('who may add a customer, location or carrier on screen', () => {
  it('hides every add for Jason, even with the Shipments and Loads grants that opened it before', () => {
    user.current = { email: 'jason@bcatcorp.com', groups: ['page-tms', 'page-loads', 'page-customers'] }
    expect(renderHook(() => useCanCreateDirectoryRecords()).result.current).toBe(false)
    expect(renderHook(() => useCanCreateCustomer()).result.current).toBe(false)
  })

  it('leaves it open for a dispatcher, an ADMIN on the same address, and the owner', () => {
    user.current = { email: 'ruben@bcatcorp.com', groups: ['page-tms'] }
    expect(renderHook(() => useCanCreateDirectoryRecords()).result.current).toBe(true)
    expect(renderHook(() => useCanCreateCustomer()).result.current).toBe(true)
    user.current = { email: 'jason@bcatcorp.com', groups: ['ADMIN'] }
    expect(renderHook(() => useCanCreateCustomer()).result.current).toBe(true)
    user.current = { email: 'ryne@bcatcorp.com', groups: [] }
    expect(renderHook(() => useCanCreateDirectoryRecords()).result.current).toBe(true)
  })
})
