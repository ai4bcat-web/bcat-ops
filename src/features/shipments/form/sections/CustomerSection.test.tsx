// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CustomerRecord } from '@/types/tms'
import { emptyValues, type ShipmentFormValues } from '../model'
import type { FormCtx } from '../sectionProps'
import { CustomerSection } from './CustomerSection'
import { ValuesHost, type Host } from './SectionHost'
import { makeCtx, sliceChange } from './sectionTestKit'

// The real picker is a search box; what matters here is which customers it is OFFERED and what we do with a pick.
vi.mock('@/components/directory-picker/DirectoryPicker', () => ({
  DirectoryPicker: ({ customers, onChange }: { customers: CustomerRecord[]; onChange: (id: string | null, r?: CustomerRecord) => void }) => (
    <ul data-testid="offered">
      {customers.map((c) => <li key={c.id}><button type="button" onClick={() => onChange(c.id, c)}>{c.name}</button></li>)}
    </ul>
  ),
}))

const base = { createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }
const ACME = {
  ...base, id: 'c-acme', name: 'Acme Foods', status: 'ACTIVE', active: true, defaultDivisionKey: 'FOOD',
  billingAddress: { street: '1 Main St', city: 'Joliet', state: 'IL', zip: '60431', country: 'US' },
  contacts: [
    { id: 'k1', name: 'Pat Primary', email: 'pat@acme.test', phone: '+13125550100', types: ['PRIMARY'], notifications: ['PICKUP'], active: true },
    { id: 'k2', name: 'Gone', email: 'gone@acme.test', types: [], notifications: [], active: false },
  ],
  billToParties: [{ id: 'b1', name: 'Acme AP', isDefault: true }, { id: 'b2', name: 'Acme Alt', isDefault: false }],
} as unknown as CustomerRecord
const PENDING = { ...base, id: 'c-pend', name: 'Pending Co', status: 'PENDING', active: true } as unknown as CustomerRecord
const BLOCKED = { ...base, id: 'c-blk', name: 'Blocked Co', status: 'BLOCKED', active: false } as unknown as CustomerRecord

function setup(over: Partial<FormCtx> = {}, seed?: (v: ShipmentFormValues) => ShipmentFormValues) {
  const host: { current: Host | null } = { current: null }
  render(
    <ValuesHost onHost={(h) => { host.current = h }} initial={seed ? seed(emptyValues()) : undefined}>
      {(values, update, form) => {
        const customer = [ACME].find((c) => c.id === values.customer.id) ?? null
        const ctx = makeCtx({ directory: { customers: [ACME, PENDING, BLOCKED], locations: [], carriers: [], staff: [] }, customer, ...over })
        return <CustomerSection value={values.customer} onChange={sliceChange(update, 'customer')} ctx={ctx} form={form} />
      }}
    </ValuesHost>,
  )
  return host
}

describe('CustomerSection', () => {
  it('offers only shippable customers', () => {
    setup()
    const offered = screen.getByTestId('offered').textContent
    expect(offered).toContain('Acme Foods')
    expect(offered).not.toContain('Pending Co')
    expect(offered).not.toContain('Blocked Co')
  })

  it('picking a customer seeds bill-to, primary contact and e-mails but never overwrites what was typed', () => {
    const host = setup(undefined, (v) => ({ ...v, customer: { ...v.customer, hours: '8-4' }, ship: { ...v.ship, revDivision: 'MINE' } }))
    fireEvent.click(screen.getByText('Acme Foods'))
    const v = host.current!.getValues()
    expect(v.customer.id).toBe('c-acme')
    expect(v.customer.billToId).toBe('b1')
    expect(v.customer.contactId).toBe('k1')
    expect(v.customer.emails[0]).toBe('pat@acme.test')
    expect(v.customer.emails).toHaveLength(6)
    expect(v.customer.hours).toBe('8-4')
    expect(v.ship.revDivision).toBe('MINE')
    expect(screen.getByLabelText('City')).toHaveProperty('value', 'Joliet')
    expect(screen.getByLabelText('Phone')).toHaveProperty('value', '(312) 555-0100')
  })

  it('shows six Email slots and hides inactive contacts', () => {
    setup(undefined, (v) => ({ ...v, customer: { ...v.customer, id: 'c-acme' } }))
    for (let n = 1; n <= 6; n++) expect(screen.getByLabelText(`Email ${n}`)).toBeTruthy()
    const contact = screen.getByLabelText('Contact') as HTMLSelectElement
    expect(Array.from(contact.options).map((o) => o.text)).toEqual(['', 'Pat Primary'])
  })

  it('records a typed name only when the person chooses to, and never with a customer id', () => {
    const host = setup()
    expect(screen.queryByLabelText('Name (required)', { selector: 'input' })).toBeNull()
    fireEvent.click(screen.getByLabelText('No matching customer — record the name for now'))
    fireEvent.change(screen.getByLabelText('Name (required)'), { target: { value: 'Mystery Broker' } })
    const v = host.current!.getValues()
    expect(v.customer.typedName).toBe('Mystery Broker')
    expect(v.customer.id).toBe('')
    expect(v.customer.useTyped).toBe(true)
  })

  it('locks the name after create and points at the detail page to change it', () => {
    const ctx = makeCtx({
      mode: 'edit', locked: { fields: { customer: 'Change the customer from the shipment page.' }, stops: {}, voided: false },
      bundle: { shipment: { id: 'S1' } } as unknown as FormCtx['bundle'],
    })
    setup(ctx, (v) => ({ ...v, customer: { ...v.customer, id: 'c-acme' } }))
    expect(screen.getByLabelText('Name (required)')).toHaveProperty('readOnly', true)
    expect(screen.getByText('Change customer…').getAttribute('href')).toBe('/tms/shipments/S1')
  })

  it('clearing the customer keeps the typed fields', () => {
    const host = setup(undefined, (v) => ({ ...v, customer: { ...v.customer, id: 'c-acme', billToId: 'b1', hours: '9-5' } }))
    fireEvent.click(screen.getByLabelText('Clear customer'))
    const v = host.current!.getValues()
    expect(v.customer.id).toBe('')
    expect(v.customer.hours).toBe('9-5')
  })
})
