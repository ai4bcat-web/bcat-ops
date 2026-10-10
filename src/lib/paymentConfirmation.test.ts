import { describe, it, expect } from 'vitest'
import { paymentConfirmationEmail } from './paymentConfirmation'

describe('paymentConfirmationEmail', () => {
  it('states invoice, amount, method, date and reference', () => {
    const e = paymentConfirmationEmail({ vendor: 'Lyons Truck Parts', invoiceNumber: '157588', amountCents: 123456, paymentMethod: 'ACH', paymentDate: '2026-10-10', paymentReference: 'TXN-9', payer: 'BCAT Corp' })
    expect(e.subject).toBe('Payment sent: invoice 157588 · $1,234.56 · BCAT Corp')
    expect(e.text).toContain('Amount: $1,234.56')
    expect(e.text).toContain('Method: ACH')
    expect(e.text).toContain('Reference: TXN-9')
    expect(e.text).toContain('1 to 3 business days')
  })
  it('copes with a check and a missing amount', () => {
    const e = paymentConfirmationEmail({ vendor: null, invoiceNumber: null, amountCents: null, paymentMethod: 'Check', paymentDate: '2026-10-10', paymentReference: null, payer: 'BCAT Corp' })
    expect(e.subject).toBe('Payment sent: your invoice · BCAT Corp')
    expect(e.text).toContain('mailing time')
    expect(e.text).not.toContain('Reference:')
  })
})
