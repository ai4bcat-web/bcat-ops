// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { CustomerRecord } from '@/types/tms'
import { CustomerContact, CustomerPicker, CustomerRef } from './CustomerCard'
import { renderCard } from './cardTestKit'
import { pushRecent } from './recents'

vi.mock('@/hooks/useCustomerOrders', () => ({ useCustomerOrders: () => ({ orders: [], shipments: [], loads: [], loading: false }) }))
let authGroups: string[] = []
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ userId: 'u1', email: 'rep@bcat.test', groups: authGroups }) }))

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

  it('the contact column has exactly two Email fields, and hides inactive contacts', () => {
    const contactOf = (customer: CustomerRecord) => renderCard(CustomerContact, { ctx: () => ({ customer }) })
    contactOf(mk('c1', 'Acme', { contacts: [
      { id: 'a', name: 'Active Ann', types: [], notifications: [], active: true },
      { id: 'b', name: 'Gone Gil', types: [], notifications: [], active: false },
    ] }))
    expect(screen.queryByTestId('f-customer-refNo')).toBeNull()
    expect(screen.getAllByTestId(/^f-customer-email-/)).toHaveLength(2)
    expect(screen.queryByText('Gone Gil')).toBeNull()
    expect(screen.getByText('Active Ann')).toBeTruthy()
  })

  it('there is no "typed name" checkbox: a manual create picks from the directory only', () => {
    set()
    expect(screen.queryByTestId('f-customer-useTyped')).toBeNull()
  })

  it('no match offers "+ Add <typed> as a new customer" (and Enter does the same) only to users who may create one; the dialog creates, selects and refreshes', async () => {
    const created = mk('c-new', 'ZZ Brand New Co')
    const addCustomer = vi.fn(async () => created)
    const host = renderCard(CustomerPicker, { ctx: () => ({ directory: { customers, locations: [], carriers: [], staff: [] }, addCustomer }) })
    fireEvent.change(screen.getByTestId('f-customer-name-input'), { target: { value: 'ZZ Brand New Co' } })
    expect(screen.getByTestId('f-customer-addRow').textContent).toBe('+ Add ZZ Brand New Co as a new customer')
    fireEvent.keyDown(screen.getByTestId('f-customer-name-input'), { key: 'Enter' })
    const dialog = await screen.findByRole('dialog')
    // The dialog is the New Customer form: Save stays disabled until the required fields are filled.
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    for (const [label, value] of [
      ['Street', '1 Main St'], ['City', 'Chicago'], ['State', 'IL'], ['ZIP', '60601'],
      ['Billing method', 'FACTOR'], ['Accounts payable e-mail 1', 'ap@zz.test'],
    ] as const) fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })
    fireEvent.click(within(dialog).getByRole('button', { name: /save|create|add/i }))
    await waitFor(() => expect(addCustomer).toHaveBeenCalledTimes(1))
    expect(addCustomer.mock.calls[0]![0]).toMatchObject({ name: 'ZZ Brand New Co' })
    await waitFor(() => expect(host.current!.getValues().customer.id).toBe('c-new'))
    expect(host.current!.getValues().customer.useTyped).toBe(false)
  })

  it('without the directory create permission a no-match shows no add row', () => {
    set()
    fireEvent.change(screen.getByTestId('f-customer-name-input'), { target: { value: 'ZZ Nobody Inc' } })
    expect(screen.queryByTestId('f-customer-addRow')).toBeNull()
  })

  it('an intake-extracted unmatched name shows the amber chip and the same add row, not a checkbox', () => {
    const addCustomer = vi.fn()
    renderCard(CustomerPicker, {
      seed: (v) => ({ ...v, customer: { ...v.customer, useTyped: true, typedName: 'ZZ Extracted Co' } }),
      ctx: () => ({ directory: { customers, locations: [], carriers: [], staff: [] }, addCustomer }),
    })
    expect(screen.getByTestId('f-customer-unmatched')).toBeTruthy()
    expect(screen.queryByTestId('f-customer-useTyped')).toBeNull()
    fireEvent.focus(screen.getByTestId('f-customer-name-input'))
    expect(screen.getByTestId('f-customer-addRow').textContent).toBe('+ Add ZZ Extracted Co as a new customer')
  })

  it('locks the name after create and points at the detail page to change it', () => {
    set(customers, {
      mode: 'edit', locked: { fields: { customer: 'Locked: customer is fixed once created' }, stops: {}, voided: false },
      bundle: { shipment: { id: 'sh-9' } }, customer: ACME,
    })
    expect((screen.getByTestId('f-customer-name') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.getByText('Change customer…').getAttribute('href')).toBe('/tms/shipments/sh-9')
  })

  it('an owner/ADMIN changes the customer right there: the link becomes a button that opens the change dialog', () => {
    authGroups = ['ADMIN']
    set(customers, {
      mode: 'edit', locked: { fields: { customer: 'Locked: customer is fixed once created' }, stops: {}, voided: false },
      bundle: { shipment: { id: 'sh-9', number: 'S9', customerId: ACME.id, customerName: ACME.name, updatedAt: 't' } }, customer: ACME,
    })
    const change = screen.getByTestId('f-customer-change')
    expect(change.tagName).toBe('BUTTON')
    fireEvent.click(change)
    expect(screen.getByText('Reason (optional)')).toBeTruthy()
  })
})

describe('CustomerRef (header strip)', () => {
  const ref = (customer: CustomerRecord | null, settings: unknown = null) =>
    renderCard(CustomerRef, { ctx: () => ({ customer, settings: settings as never }) })
  const wrapper = () => screen.getByTestId('f-customer-refNo').closest('.tms-fg-field') as HTMLElement

  it('edits the one customer.refNo value and labels it Customer ref', () => {
    const host = ref(ACME)
    fireEvent.change(screen.getByTestId('f-customer-refNo'), { target: { value: 'PO-77' } })
    expect(host.current!.getValues().customer.refNo).toBe('PO-77')
    expect(wrapper().querySelector('.tms-fg-label-text')!.textContent).toBe('Customer ref')
  })

  it('is always required, whatever the customer settings say', () => {
    ref(ACME)
    expect(wrapper().classList.contains('tms-field-req')).toBe(true)
    cleanup()
    ref(mk('c3', 'Opted out', { reviewRequirements: ['salesRep'] }))
    expect(wrapper().classList.contains('tms-field-req')).toBe(true)
  })
})
