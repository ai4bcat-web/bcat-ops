// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, renderHook } from '@testing-library/react'
import type { CustomerRecord } from '@/types/tms'
import { DirectoryCreateDialog } from '@/components/directory-picker/DirectoryCreateDialog'
import { useCustomerForm } from './components/useCustomerForm'
import { customerInvoiceEmailState } from '@/lib/emailReadiness'
import { stateOf } from '@/lib/billingSetupCsv'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

vi.mock('@/lib/apiClient', () => ({
  listUserProfiles: vi.fn(async () => []),
  listDivisions: vi.fn(async () => []),
  listOwnershipDivisions: vi.fn(async () => []),
  getTmsSettings: vi.fn(async () => null),
  geocodeAddress: vi.fn(),
  autocompleteAddress: vi.fn(async () => []),
  getPlaceDetails: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : ''),
}))

afterEach(cleanup)

const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
const missing = () => screen.queryByTestId('customer-missing')?.textContent ?? null
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

function open(onSave = vi.fn(async (_r: unknown) => {})) {
  render(<DirectoryCreateDialog type="customer" open tmsTheme onClose={vi.fn()} onSave={onSave} />)
  return onSave
}

function fillRequired() {
  type('Name', 'Acme Foods')
  type('Street', '1 Main St')
  type('City', 'Chicago')
  type('State', 'IL')
  type('ZIP', '60601')
  type('Billing method', 'MANUAL')
  type('Accounts payable e-mail 1', 'ap@acme.example')
}

describe('New Customer form', () => {
  it('marks every required field with a red asterisk and the word Required', () => {
    open()
    const group = screen.getByTestId('new-customer-required')
    const tags = group.querySelectorAll('[data-testid="required-tag"]')
    // Name, Address, Active, Default rev division, Billing method, AP e-mail 1
    expect(tags).toHaveLength(6)
    for (const tag of tags) {
      expect(tag.textContent).toBe('Required')
      const star = tag.previousElementSibling
      expect(star?.textContent).toBe('*')
      expect((star as HTMLElement).style.color).toBe('var(--tms-badge-red)')
    }
    // The copy-to e-mail and credit limit are pre-filled, not required.
    expect(screen.getByText('Accounts payable copy-to e-mail').textContent).not.toContain('Required')
  })

  it('opens with the defaults: Active on, Ivan Cartage, copy-to pre-filled, $1,000,000, no billing method', () => {
    open()
    expect((screen.getByLabelText('Active') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Default rev division') as HTMLSelectElement).value).toBe('ASSETS')
    expect((screen.getByLabelText('Accounts payable copy-to e-mail') as HTMLTextAreaElement).value).toBe('invoices@bcatcorp.com')
    expect((screen.getByLabelText('Credit limit ($)') as HTMLInputElement).value).toBe('1,000,000.00')
    const method = screen.getByLabelText('Billing method') as HTMLSelectElement
    expect(method.value).toBe('')
    expect([...method.options].map((o) => o.textContent)).toEqual(['— choose —', 'Factor', 'Invoice manually'])
    const division = screen.getByLabelText('Default rev division') as HTMLSelectElement
    expect([...division.options].map((o) => o.value)).toEqual(expect.arrayContaining(['', 'BROKERAGE', 'ASSETS']))
  })

  it('keeps Save disabled and lists what is missing until the form is valid', () => {
    open()
    expect(save().disabled).toBe(true)
    expect(missing()).toBe('Missing: Name, Address, Billing method, AP e-mail 1')
    type('Name', 'Acme Foods')
    expect(missing()).toBe('Missing: Address, Billing method, AP e-mail 1')
    type('Street', '1 Main St'); type('City', 'Chicago'); type('State', 'IL')
    expect(missing()).toContain('Address')
    type('ZIP', '60601')
    type('Billing method', 'FACTOR')
    expect(missing()).toBe('Missing: AP e-mail 1')
    type('Accounts payable e-mail 1', 'not-an-email')
    expect(save().disabled).toBe(true)
    type('Accounts payable e-mail 1', 'ap@acme.example')
    expect(missing()).toBeNull()
    expect(save().disabled).toBe(false)
  })

  it('shows the inline error under a field once it is visited', () => {
    open()
    expect(screen.queryByText('Name is required')).toBeNull()
    fireEvent.blur(screen.getByLabelText('Name'))
    expect(screen.getByText('Name is required').className).toContain('tms-field-error')
    fireEvent.blur(screen.getByLabelText('Billing method'))
    expect(screen.getByText('Choose Factor or Invoice manually')).toBeTruthy()
    type('Accounts payable e-mail 1', 'nope')
    fireEvent.blur(screen.getByLabelText('Accounts payable e-mail 1'))
    expect(screen.getByText('Enter a valid e-mail address')).toBeTruthy()
    fireEvent.blur(screen.getByLabelText('Street'))
    expect(screen.getByText(/Address is required/)).toBeTruthy()
    type('Accounts payable copy-to e-mail', 'invoices@bcatcorp.com\nbroken')
    fireEvent.blur(screen.getByLabelText('Accounts payable copy-to e-mail'))
    expect(screen.getByText('Not a valid e-mail: broken')).toBeTruthy()
    expect(missing()).toContain('AP copy-to e-mail')
  })

  it('saves Factor / Invoice manually as FACTOR / MANUAL with the defaults and the cents', async () => {
    const onSave = open()
    fillRequired()
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      name: 'Acme Foods', active: true, billingMethod: 'MANUAL', apEmail: 'ap@acme.example',
      defaultDivisionKey: 'ASSETS', creditLimitCents: 100_000_000,
      invoiceCopyEmails: ['invoices@bcatcorp.com'],
      billingAddress: { street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
    })
  })

  it('converts an edited credit limit to integer cents', async () => {
    const onSave = open()
    fillRequired()
    const credit = screen.getByLabelText('Credit limit ($)')
    fireEvent.focus(credit)
    fireEvent.change(credit, { target: { value: '2,500.50' } })
    fireEvent.blur(credit)
    expect((screen.getByLabelText('Credit limit ($)') as HTMLInputElement).value).toBe('2,500.50')
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ creditLimitCents: 250050 })
  })

  it('keeps invoices@bcatcorp.com in the saved list when it is removed, and adds the extras', async () => {
    const onSave = open()
    fillRequired()
    type('Accounts payable copy-to e-mail', 'Extra@Acme.example')
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect((onSave.mock.calls[0]![0] as CustomerRecord).invoiceCopyEmails).toEqual(['invoices@bcatcorp.com', 'extra@acme.example'])
  })

  it('a customer created through the form never lands in the invoice e-mail / billing method flags', async () => {
    const onSave = open()
    for (const method of ['FACTOR', 'MANUAL']) {
      cleanup()
      onSave.mockClear()
      open(onSave)
      fillRequired()
      type('Billing method', method)
      fireEvent.click(save())
      await waitFor(() => expect(onSave).toHaveBeenCalled())
      const record = onSave.mock.calls[0]![0] as CustomerRecord
      expect(customerInvoiceEmailState(record)).toBe('OK')
      expect(stateOf(record)).toBe(method)
    }
  })
})

describe('existing customers keep editing', () => {
  const old = { id: 'c-old', name: 'Old Co', createdAt: '', updatedAt: '' } as CustomerRecord

  it('an old customer without the new fields has no required-field errors and a clean record', () => {
    const { result } = renderHook(() => useCustomerForm(old))
    expect(result.current.isNew).toBe(false)
    expect(result.current.missing).toBeNull()
    expect(result.current.errors).toEqual({})
    expect(result.current.value).toMatchObject({ billingMethod: '', apEmail: '', defaultDivisionKey: '', creditLimitCents: null, invoiceCopyText: '' })
    expect(result.current.toRecord().invoiceCopyEmails).toEqual([])
  })
})
