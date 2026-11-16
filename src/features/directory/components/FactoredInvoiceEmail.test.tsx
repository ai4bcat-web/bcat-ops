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

describe('AP e-mail for every customer (Ryne 2026-11-16: required, factored customers included)', () => {
  it('is in the billing method section and says it is required for a factored customer', () => {
    render(<Harness initial={{ billingMethod: 'FACTOR', apEmail: 'ap@motus.test' }} />)
    expect(screen.getByText('AP e-mails (required)')).toBeTruthy()
    expect(screen.getByText(/Required for every customer\. This customer factors/)).toBeTruthy()
    expect(screen.getAllByTestId('email-chip').map((c) => c.textContent)).toContain('ap@motus.test')
    expect(screen.getByLabelText('Notice of assignment email')).toBeTruthy()
  })
  it('says it is required for a manual customer', () => {
    render(<Harness initial={{ billingMethod: 'MANUAL', apEmail: 'ap@acme.test' }} />)
    expect(screen.getByText('AP e-mails (required)')).toBeTruthy()
    expect(screen.getByText(/Required for every customer\. The first address is the main one/)).toBeTruthy()
  })
  it('the list chip for a factored customer with no address is flagged like any other missing address', () => {
    render(<InvoiceEmailBadge customer={{ billingMethod: 'FACTOR', apEmail: null }} />)
    const chip = screen.getByText('This customer factors · Missing AP e-mail (required)')
    expect(chip.className).not.toContain('tms-badge-gray')
    cleanup()
    render(<InvoiceEmailBadge customer={{ billingMethod: 'MANUAL', apEmail: null }} />)
    expect(screen.getByText('Missing invoice e-mail').className).not.toContain('tms-badge-gray')
  })
})
