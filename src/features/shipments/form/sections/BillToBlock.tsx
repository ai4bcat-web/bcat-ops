/**
 * Read-only BILL TO block under Customer (Ryne's feedback #4): payment terms, factoring,
 * billing e-mails, credit limit and what is still available. Filled from the customer record
 * and its credit exposure; nothing here is editable (the link opens the customer profile).
 * Mounted only while a customer is chosen, so the exposure read happens only then.
 */
import { memo, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useCustomerOrders } from '@/hooks/useCustomerOrders'
import { creditSummaryForCustomer } from '@/lib/customerCredit'
import { formatCents } from '@/lib/invoiceBuild'
import type { CustomerRecord, TmsSettings } from '@/types/tms'
import { billingEmailsOf } from './fieldUtil'

interface BillToBlockProps {
  customer: CustomerRecord
  settings: TmsSettings | null
  /** The bill-to party picked above, when the customer has several. */
  billToId: string
}

const ROWS = {
  terms: 'Payment Terms',
  factoring: 'Factoring',
  emails: 'Billing Emails',
  limit: 'Credit Limit',
  available: 'Available Credit',
} as const

function BillToBlockImpl({ customer, settings, billToId }: BillToBlockProps) {
  const { orders, shipments, loads, loading } = useCustomerOrders(customer.id, customer)
  const summary = useMemo(
    () => creditSummaryForCustomer(customer, settings, { orders, shipments, loads }),
    [customer, settings, orders, shipments, loads],
  )
  const party = customer.billToParties?.find((b) => b.id === billToId)
  const termsDays = party?.paymentTermsDays ?? customer.paymentTermsDays ?? null
  const limit = summary.policy.creditLimitCents
  const emails = billingEmailsOf(customer, billToId)

  const rows: [keyof typeof ROWS, string][] = [
    ['terms', termsDays === null ? '—' : termsDays === 0 ? 'Due on receipt' : `Net ${termsDays}`],
    ['factoring', customer.factored === true ? 'Factored' : 'No factor'],
    ['emails', emails.length > 0 ? emails.join(', ') : '—'],
    ['limit', limit === null ? 'No limit set' : formatCents(limit)],
    ['available', limit === null ? '—' : loading || summary.availableCents === null ? '…' : formatCents(summary.availableCents)],
  ]

  return (
    <div className="ship-billto" role="group" aria-label="Bill To" data-testid="f-customer-billToBlock">
      <div className="ship-inline">
        <strong>Bill To</strong>
        <Link className="ship-link" to={`/tms/customers/${customer.id}`}>Open customer profile</Link>
      </div>
      <dl className="ship-billto-list">
        {rows.map(([key, text]) => (
          <div key={key} className="ship-billto-row">
            <dt>{ROWS[key]}</dt>
            <dd data-testid={`f-customer-billTo-${key}`}>{text}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export const BillToBlock = memo(BillToBlockImpl)
