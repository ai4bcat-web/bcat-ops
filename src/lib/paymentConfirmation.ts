/**
 * The payment confirmation a vendor gets when the office records a payment.
 * Plain text, short, and only facts the vendor can match against their books.
 */
export interface PaymentConfirmationInput {
  vendor: string | null | undefined
  invoiceNumber: string | null | undefined
  amountCents: number | null | undefined
  paymentMethod: string
  paymentDate: string
  paymentReference: string | null | undefined
  payer: string
}

export function paymentConfirmationEmail(i: PaymentConfirmationInput): { subject: string; text: string } {
  const amount = i.amountCents != null ? `$${(i.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'the invoiced amount'
  const inv = i.invoiceNumber ? `invoice ${i.invoiceNumber}` : 'your invoice'
  const subject = `Payment sent: ${inv}${i.amountCents != null ? ` · ${amount}` : ''} · ${i.payer}`
  const lines = [
    `Hello${i.vendor ? ` ${i.vendor}` : ''},`,
    '',
    `${i.payer} has sent payment for ${inv}.`,
    '',
    `Amount: ${amount}`,
    `Method: ${i.paymentMethod}`,
    `Date: ${i.paymentDate}`,
    ...(i.paymentReference ? [`Reference: ${i.paymentReference}`] : []),
    '',
    i.paymentMethod.toLowerCase() === 'check' ? 'Please allow mailing time for the check to arrive.' : 'Please allow 1 to 3 business days for the funds to post.',
    '',
    'Questions: reply to this email or write to vendorpayments@bcatcorp.com.',
    '',
    `${i.payer} Accounts Payable`,
  ]
  return { subject, text: lines.join('\n') }
}
