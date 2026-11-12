// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BillingMethodFields } from './BillingMethodFields'
import type { CustomerFormValue } from './useCustomerForm'

function Harness({ initial }: { initial: Partial<CustomerFormValue> }) {
  const [value, setValue] = useState({
    billingMethod: 'MANUAL', apEmail: 'ap@acme.com', apEmailsExtraText: '', invoiceCopyText: 'invoices@bcatcorp.com', billingNeedsReview: '', ...initial,
  } as CustomerFormValue)
  const set = <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => setValue((prev) => ({ ...prev, [key]: v }))
  return (
    <>
      <BillingMethodFields value={value} set={set} errors={{}} factor={null} />
      <output data-testid="extra">{value.apEmailsExtraText}</output>
      <output data-testid="copy">{value.invoiceCopyText}</output>
      <output data-testid="ap">{value.apEmail}</output>
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
})
