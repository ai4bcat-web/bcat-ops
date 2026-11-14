// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { BillingMethodFields } from './BillingMethodFields'
import { InvoiceEmailBadge } from './EmailReadinessBadge'
import type { CustomerFormValue } from './useCustomerForm'

afterEach(cleanup)

function Harness({ initial }: { initial: Partial<CustomerFormValue> }) {
  const [value, setValue] = useState({
    billingMethod: 'FACTOR', apEmail: '', apEmailsExtraText: '', invoiceCopyText: '', billingNeedsReview: '', noaEmail: '', ...initial,
  } as CustomerFormValue)
  const set = <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => setValue((prev) => ({ ...prev, [key]: v }))
  return <BillingMethodFields value={value} set={set} errors={{}} factor={null} />
}

describe('invoice e-mail for a factored customer (Ryne 2026-11-14)', () => {
  it('is in the billing method section and says it is not required', () => {
    render(<Harness initial={{ billingMethod: 'FACTOR', apEmail: 'ap@motus.test' }} />)
    expect(screen.getByText('Invoice e-mail (not required)')).toBeTruthy()
    expect(screen.getByText(/Not required: this customer factors\. Invoices go to the factor, not this address\./)).toBeTruthy()
    expect((screen.getByLabelText('AP e-mail 1') as HTMLInputElement).value).toBe('ap@motus.test')
    expect(screen.getByLabelText('Notice of assignment email')).toBeTruthy()
  })
  it('says it is required for a manual customer', () => {
    render(<Harness initial={{ billingMethod: 'MANUAL', apEmail: 'ap@acme.test' }} />)
    expect(screen.getByText('AP e-mails (invoices go here)')).toBeTruthy()
    expect(screen.getByText(/Required for manual billing/)).toBeTruthy()
  })
  it('the list chip for a factored customer with no address is neutral, not a red flag', () => {
    render(<InvoiceEmailBadge customer={{ billingMethod: 'FACTOR', apEmail: null }} />)
    const chip = screen.getByText('This customer factors · Missing invoice e-mail (not required)')
    expect(chip.className).toContain('tms-badge-gray')
    cleanup()
    render(<InvoiceEmailBadge customer={{ billingMethod: 'MANUAL', apEmail: null }} />)
    expect(screen.getByText('Missing invoice e-mail').className).not.toContain('tms-badge-gray')
  })
})
