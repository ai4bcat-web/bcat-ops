// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BillingMethodFields } from './BillingMethodFields'
import type { CustomerFormValue } from './useCustomerForm'

function Harness({ initial }: { initial: Partial<CustomerFormValue> }) {
  const [value, setValue] = useState({
    billingMethod: 'MANUAL', apEmail: 'ap@acme.com', apEmailsExtraText: '', invoiceCopyText: 'invoices@bcatcorp.com', billingNeedsReview: '', noaEmail: '', ...initial,
  } as CustomerFormValue)
  const set = <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => setValue((prev) => ({ ...prev, [key]: v }))
  return (
    <>
      <BillingMethodFields value={value} set={set} errors={{}} factor={null} />
      <output data-testid="extra">{value.apEmailsExtraText}</output>
      <output data-testid="copy">{value.invoiceCopyText}</output>
      <output data-testid="ap">{value.apEmail}</output>
      <output data-testid="noa">{value.noaEmail}</output>
    </>
  )
}

describe('BillingMethodFields address lists', () => {
  it('shows existing To and copy addresses as separate rows', () => {
    render(<Harness initial={{ apEmailsExtraText: 'b@acme.com\nc@acme.com', invoiceCopyText: 'invoices@bcatcorp.com\nf@acme.com' }} />)
    expect((screen.getByLabelText('AP e-mail 1') as HTMLInputElement).value).toBe('ap@acme.com')
    expect((screen.getByLabelText('AP e-mail 3') as HTMLInputElement).value).toBe('c@acme.com')
    expect((screen.getByLabelText('Copy on invoices 2') as HTMLInputElement).value).toBe('f@acme.com')
  })

  it('adds and removes To addresses, keeping the primary as the first row', () => {
    render(<Harness initial={{}} />)
    fireEvent.click(screen.getAllByRole('button', { name: '+ Add address' })[0])
    fireEvent.change(screen.getByLabelText('AP e-mail 2'), { target: { value: 'second@acme.com' } })
    expect(screen.getByTestId('extra').textContent).toBe('second@acme.com')
    fireEvent.click(screen.getByRole('button', { name: 'Remove AP e-mail 1' }))
    expect(screen.getByTestId('ap').textContent).toBe('second@acme.com')
    expect(screen.getByTestId('extra').textContent).toBe('')
  })

  it('adds a copy address', () => {
    render(<Harness initial={{}} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add copy address' }))
    fireEvent.change(screen.getByLabelText('Copy on invoices 2'), { target: { value: 'f@acme.com' } })
    expect(screen.getByTestId('copy').textContent).toBe('invoices@bcatcorp.com\nf@acme.com')
  })

  it('shows the notice of assignment e-mail for a factor customer and for one with no method, and keeps it separate from AP e-mail', () => {
    const { unmount } = render(<Harness initial={{ billingMethod: 'FACTOR' }} />)
    fireEvent.change(screen.getByTestId('billing-noa-email'), { target: { value: 'noa@factor.com' } })
    expect(screen.getByTestId('noa').textContent).toBe('noa@factor.com')
    expect(screen.getByTestId('ap').textContent).toBe('ap@acme.com')
    unmount()
    render(<Harness initial={{ billingMethod: '' }} />)
    expect(screen.getByTestId('billing-noa-email')).toBeTruthy()
  })

  it('hides it for a manual customer unless it already holds an address', () => {
    const { unmount } = render(<Harness initial={{ billingMethod: 'MANUAL' }} />)
    expect(screen.queryByTestId('billing-noa-email')).toBeNull()
    unmount()
    render(<Harness initial={{ billingMethod: 'MANUAL', noaEmail: 'noa@factor.com' }} />)
    expect((screen.getByTestId('billing-noa-email') as HTMLInputElement).value).toBe('noa@factor.com')
  })
})
