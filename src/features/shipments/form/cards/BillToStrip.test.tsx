// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { CustomerRecord, TmsSettings } from '@/types/tms'
import { BillToStrip } from './BillToStrip'
import { creditWarning, requirementChips } from './billToModel'
import { renderCard } from './cardTestKit'

const orders = vi.hoisted(() => ({ value: { orders: [] as unknown[], shipments: [] as unknown[], loads: [] as unknown[], loading: false } }))
vi.mock('@/hooks/useCustomerOrders', () => ({ useCustomerOrders: () => orders.value }))

const base = { createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }
const mk = (extra: object = {}) => ({
  ...base, id: 'c-acme', name: 'Acme Foods', status: 'ACTIVE', active: true,
  paymentTermsDays: 30, creditLimitCents: 1_000_000, factored: true,
  billingEmail: 'ap@acme.test', billingContactName: 'Dana Billing', billingPhone: '+13125550111',
  billingAddress: { street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
  billToParties: [{ id: 'b1', name: 'Acme AP', email: 'bill@acme.test', paymentTermsDays: 45, isDefault: true }],
  requiredDocsForInvoice: ['POD'], reviewRequirements: ['referenceNumber', 'salesRep'],
  ...extra,
}) as unknown as CustomerRecord
const settings = { factorRemitTo: { name: 'OTR', noticeText: 'Pay OTR' } } as unknown as TmsSettings

function setup(customer: CustomerRecord | null, open = true, onToggle: () => void = () => {}) {
  return renderCard(
    (props) => <BillToStrip {...props} open={open} onToggle={onToggle} />,
    {
      seed: (v) => ({
        ...v,
        customer: { ...v.customer, id: customer?.id ?? '', billToId: 'b1' },
      }),
      ctx: () => ({ customer, settings }),
    },
  )
}
const t = (id: string) => screen.getByTestId(id).textContent

describe('BillToStrip', () => {
  it('shows the empty state with no customer', () => {
    setup(null)
    expect(t('card-billTo-empty')).toBe('Choose a customer to see billing details')
    expect(screen.queryByTestId('f-customer-billToBlock')).toBeNull()
  })

  it('renders each field from the customer fixture', () => {
    setup(mk())
    expect(t('card-billTo-party')).toContain('Acme AP')
    expect(t('card-billTo-party')).toContain('1 Main St, Chicago, IL 60601')
    expect(t('f-customer-billTo-terms')).toBe('Net 45')
    expect(t('f-customer-billTo-limit')).toBe('$10,000.00')
    expect(t('f-customer-billTo-available')).toBe('$10,000.00')
    expect(t('card-billTo-openAr')).toBe('$0.00')
    expect(t('f-customer-billTo-factoring')).toBe('Factored via OTR')
    expect(t('card-billTo-noa')).toBe('Notice of assignment on invoices')
    expect(t('f-customer-billTo-emails')).toBe('bill@acme.test, ap@acme.test')
    expect(t('card-billTo-contact')).toContain('Dana Billing')
    expect(t('card-billTo-status')).toBe('ACTIVE')
    expect(screen.getByTestId('card-billTo-open').getAttribute('href')).toBe('/tms/customers/c-acme')
    expect(screen.queryByTestId('card-billTo-creditWarn')).toBeNull()
  })

  it('the billing detail has no editable inputs; the contact column beside it does', () => {
    setup(mk())
    const body = screen.getByTestId('f-customer-billToBlock')
    expect(within(body).queryAllByRole('textbox')).toHaveLength(0)
    expect(body.querySelector('input,select,textarea')).toBeNull()
    expect(screen.getByTestId('f-customer-refNo')).toBeTruthy()
    expect(screen.getByTestId('f-customer-email-1')).toBeTruthy()
  })

  it('the chip summarises name, terms, factoring and available credit, and the panel is hidden until opened', () => {
    setup(mk(), false)
    expect(t('hdr-billTo-text')).toBe('Acme AP · Net 45 · Factored · $10,000.00 available')
    expect(screen.getByTestId('hdr-billTo-chip').getAttribute('aria-expanded')).toBe('false')
    expect((screen.getByTestId('ship-form-header-panel') as HTMLElement).hidden).toBe(true)
    // Hidden, but still mounted so its fields keep their test ids.
    expect(screen.getByTestId('f-customer-refNo')).toBeTruthy()
  })

  it('the chip goes amber and says CREDIT HOLD for a customer on hold; the toggle calls back', () => {
    const toggle = vi.fn()
    setup(mk({ creditHoldFlag: true }), false, toggle)
    expect(screen.getByTestId('hdr-billTo-chip').getAttribute('data-hold')).toBe('true')
    expect(t('hdr-billTo-text')).toMatch(/^CREDIT HOLD · /)
    screen.getByTestId('hdr-billTo-chip').click()
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('with no customer the chip asks for one', () => {
    setup(null, false)
    expect(t('hdr-billTo-text')).toBe('Bill To: choose a customer')
    expect(screen.getByTestId('hdr-billTo-chip').getAttribute('data-hold')).toBe('false')
  })

  it('shows not-factored and requirement chips', () => {
    setup(mk({ factored: false }))
    expect(t('f-customer-billTo-factoring')).toBe('Not factored')
    const chips = screen.getAllByTestId('card-billTo-chip').map((c) => c.textContent)
    expect(chips).toEqual(['POD required', 'PO / ref required', 'Sales rep required'])
  })

  it('flags a customer on credit hold', () => {
    setup(mk({ creditHoldFlag: true }))
    expect(t('card-billTo-status')).toBe('CREDIT HOLD')
    expect(t('card-billTo-creditWarn')).toContain('on hold')
  })
})

describe('creditWarning / requirementChips', () => {
  it('hold wins, over-limit needs a limit, equal total is fine', () => {
    expect(creditWarning(true, 100, 1)).toEqual({ kind: 'hold' })
    expect(creditWarning(false, 100, 101)).toEqual({ kind: 'over', totalCents: 101, availableCents: 100 })
    expect(creditWarning(false, 100, 100)).toBeNull()
    expect(creditWarning(false, null, 999)).toBeNull()
  })
  it('an empty customer list means nothing required; null falls to the org default', () => {
    expect(requirementChips(mk({ reviewRequirements: [], requiredDocsForInvoice: [] }), null)).toEqual([])
    expect(requirementChips(mk({ reviewRequirements: null, requiredDocsForInvoice: [] }), { reviewRequirements: ['salesRep'] } as unknown as TmsSettings)).toEqual(['Sales rep required'])
  })
})
