// @vitest-environment jsdom
/** The Invoice channel select on the customer profile's Account tab: admins set it, everyone else sees it locked, and a save carries it. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const auth = vi.hoisted(() => ({ user: { userId: 'u', email: 'ryne@bcatcorp.com', groups: [] as string[] }, isAdmin: true, isOwner: true, hasPageAccess: () => true }))

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth, useAuthUser: () => auth.user }))
vi.mock('@/hooks/useOtrNoBuy', () => ({ useOtrNoBuy: () => new Map() }))
vi.mock('@/hooks/useCustomerOrders', () => ({ useCustomerOrders: () => ({ loads: [], orders: [], shipments: [], lastLoadAt: null, loading: false }) }))
vi.mock('@/hooks/useCustomerAr', () => ({ useCustomerAr: () => ({ invoices: [], payments: [], loading: false }) }))
vi.mock('@/hooks/useCustomerQuotes', () => ({ useCustomerQuotes: () => ({ quotes: [], loading: false, error: null }) }))
vi.mock('../useUnlinkedShipments', () => ({ useUnlinkedShipments: () => ({ rows: [], total: 0, loading: false, error: null, loaded: true, refresh: () => {}, dropLinked: () => {} }) }))
vi.mock('@/features/crm/useCrmAccount', () => ({
  useCrmAccount: () => ({ view: null, loading: false, error: null, setNextStep: vi.fn(), releaseDomain: vi.fn(), addActivity: vi.fn(), addTask: vi.fn(), completeTask: vi.fn() }),
}))
vi.mock('./CrmStrip', () => ({ CrmStrip: () => null }))

import { CustomerProfile } from './CustomerProfile'
import type { CustomerRecord } from '@/types/tms'

const customer = { id: 'c-auto', name: 'AUTO SHIPPER', status: 'ACTIVE', customerType: 'SHIPPER', billingMethod: 'MANUAL', paymentTermsDays: 30, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as unknown as CustomerRecord

function mount(isAdmin: boolean, onSave = vi.fn(async () => {})) {
  auth.isAdmin = isAdmin
  render(
    <MemoryRouter>
      <CustomerProfile
        customer={customer}
        divisions={[]}
        locations={[]}
        settings={null}
        catalog={[]}
        isAdmin={isAdmin}
        currentUser="ryne@bcatcorp.com"
        activeCustomers={[customer]}
        onClose={() => {}}
        onSave={onSave}
        onStatusChange={async () => {}}
      />
    </MemoryRouter>,
  )
  return onSave
}

afterEach(cleanup)

describe('customer profile Invoice channel', () => {
  it('lets an admin pick the Square channel and saves it', async () => {
    const onSave = mount(true)
    const select = screen.getByLabelText('Invoice channel') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    expect(select.value).toBe('')
    fireEvent.change(select, { target: { value: 'SQUARE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const saved = (onSave.mock.calls[0] as unknown[])[1] as { invoiceChannel?: string | null }
    expect(saved.invoiceChannel).toBe('SQUARE')
  })

  it('shows the field locked for anyone who is not an admin', () => {
    mount(false)
    expect((screen.getByLabelText('Invoice channel') as HTMLSelectElement).disabled).toBe(true)
  })
})
