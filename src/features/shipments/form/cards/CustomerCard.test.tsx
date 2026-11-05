// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import type { CustomerRecord } from '@/types/tms'
import { CustomerCard } from './CustomerCard'
import { renderCard } from './cardTestKit'
import { pushRecent } from './recents'

vi.mock('@/hooks/useCustomerOrders', () => ({ useCustomerOrders: () => ({ orders: [], shipments: [], loads: [], loading: false }) }))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ userId: 'u1', email: 'rep@bcat.test', groups: [] }) }))

const base = { createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }
const mk = (id: string, name: string, extra: object = {}) => ({ ...base, id, name, status: 'ACTIVE', active: true, ...extra }) as unknown as CustomerRecord
const ACME = mk('c-acme', 'Acme Foods', {
  defaultDivisionKey: 'FOOD', defaultSalesRepId: 'rep-1',
  contacts: [{ id: 'k1', name: 'Pat Primary', email: 'pat@acme.test', phone: '+13125550100', types: ['PRIMARY'], notifications: ['PICKUP'], active: true }],
  billToParties: [{ id: 'b1', name: 'Acme AP', isDefault: true }],
})
const KROGER = mk('c-kro', 'Kroger Dallas')
const ACORN = mk('c-acorn', 'Acorn Freight')
const BLOCKED = mk('c-blk', 'Acme Blocked', { status: 'BLOCKED', active: false })
const customers = [ACME, KROGER, ACORN, BLOCKED]

beforeEach(() => localStorage.clear())

const setup = () => renderCard(CustomerCard, {
  ctx: (v) => ({ directory: { customers, locations: [], carriers: [], staff: [] }, customer: customers.find((c) => c.id === v.customer.id) ?? null }),
})
const options = () => within(screen.getByTestId('f-customer-name')).queryAllByRole('option').map((o) => o.textContent)

describe('CustomerCard', () => {
  it('offers the recently used customers first when the box is focused empty, newest first', () => {
    pushRecent('customer', 'rep@bcat.test', 'c-kro')
    pushRecent('customer', 'rep@bcat.test', 'c-acorn')
    setup()
    fireEvent.focus(screen.getByTestId('f-customer-name-input'))
    expect(options()).toEqual(['Acorn FreightRecent', 'Kroger DallasRecent'])
  })

  it('ranks a recent customer above an equally good match, and never offers a blocked one', () => {
    pushRecent('customer', 'rep@bcat.test', 'c-acorn')
    setup()
    fireEvent.change(screen.getByTestId('f-customer-name-input'), { target: { value: 'Ac' } })
    const names = options()
    expect(names[0]).toBe('Acorn FreightRecent')
    expect(names.join('|')).not.toContain('Blocked')
  })

  it('choosing a customer seeds Bill To, contact, e-mail, sales rep and division, and remembers the pick', () => {
    const host = setup()
    fireEvent.change(screen.getByTestId('f-customer-name-input'), { target: { value: 'Acme Foods' } })
    fireEvent.click(screen.getAllByTestId('f-customer-name').flatMap((g) => within(g).getAllByRole('option'))[0].querySelector('button')!)
    const v = host.current!.getValues()
    expect(v.customer).toMatchObject({ id: 'c-acme', billToId: 'b1', contactId: 'k1' })
    expect(v.customer.emails[0]).toBe('pat@acme.test')
    expect(v.roles.salesRepId).toBe('rep-1')
    expect(v.ship.revDivision).toBe('FOOD')
    expect(screen.getByTestId('f-customer-billToBlock')).toBeTruthy()
    expect(screen.getAllByTestId(/^f-customer-email-/)).toHaveLength(2)
    expect(localStorage.getItem('tms:ship-form:recent:customer:rep@bcat.test')).toBe('["c-acme"]')
  })
})
