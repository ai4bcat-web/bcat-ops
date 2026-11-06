// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import type { CustomerRecord } from '@/types/tms'
import { CustomerContact, CustomerPicker } from './CustomerCard'
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

const setup = () => renderCard(CustomerPicker, {
  ctx: (v) => ({ directory: { customers, locations: [], carriers: [], staff: [] }, customer: customers.find((c) => c.id === v.customer.id) ?? null }),
})
const options = () => within(screen.getByTestId('f-customer-name')).queryAllByRole('option').map((o) => o.textContent)

describe('CustomerPicker', () => {
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
    expect(localStorage.getItem('tms:ship-form:recent:customer:rep@bcat.test')).toBe('["c-acme"]')
  })
})

describe('CustomerPicker — typed name, lock', () => {
  const set = (c: Partial<CustomerRecord>[] = customers, over: object = {}) =>
    renderCard(CustomerPicker, { ctx: () => ({ directory: { customers: c as CustomerRecord[], locations: [], carriers: [], staff: [] }, ...over }) })

  it('the contact column has Ref #, exactly two Email fields, and hides inactive contacts', () => {
    const contactOf = (customer: CustomerRecord) => renderCard(CustomerContact, { ctx: () => ({ customer }) })
    contactOf(mk('c1', 'Acme', { contacts: [
      { id: 'a', name: 'Active Ann', types: [], notifications: [], active: true },
      { id: 'b', name: 'Gone Gil', types: [], notifications: [], active: false },
    ] }))
    expect(screen.getByTestId('f-customer-refNo')).toBeTruthy()
    expect(screen.getAllByTestId(/^f-customer-email-/)).toHaveLength(2)
    expect(screen.queryByText('Gone Gil')).toBeNull()
    expect(screen.getByText('Active Ann')).toBeTruthy()
  })

  it('records a typed name only when the person chooses to, and never with a customer id', () => {
    const host = set()
    expect(screen.getByTestId('f-customer-useTyped')).toBeTruthy()
    fireEvent.click(screen.getByTestId('f-customer-useTyped'))
    fireEvent.change(screen.getByTestId('f-customer-name'), { target: { value: 'Brand New Co' } })
    expect(host.current!.getValues().customer).toMatchObject({ useTyped: true, typedName: 'Brand New Co', id: '' })
  })

  it('locks the name after create and points at the detail page to change it', () => {
    set(customers, {
      mode: 'edit', locked: { fields: { customer: 'Locked: customer is fixed once created' }, stops: {}, voided: false },
      bundle: { shipment: { id: 'sh-9' } }, customer: ACME,
    })
    expect((screen.getByTestId('f-customer-name') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.getByText('Change customer…').getAttribute('href')).toBe('/tms/shipments/sh-9')
  })
})
