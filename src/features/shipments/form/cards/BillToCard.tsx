/**
 * Card 2: Bill To (Step AR feedback 2). Read-only billing detail for the chosen customer, filled
 * on select: bill-to party and address, terms, credit limit / open AR / available credit,
 * factoring and notice of assignment, billing contacts, invoicing requirements, status badge and
 * a credit-hold strip. No controls: the bill-to party select stays in the Customer card (it is data, as in AH).
 *
 * No new reads: credit comes from `useCustomerOrders` (the same per-customer read the AH block
 * and the Customers profile use); Open AR is its INVOICED bucket (billed, unpaid). The
 * whole-table `CRM_LIST_ACCOUNTS` read is deliberately not used here.
 */
import { memo, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge } from '@/features/tms/kit'
import { useCustomerOrders } from '@/hooks/useCustomerOrders'
import { creditSummaryForCustomer } from '@/lib/customerCredit'
import { formatCents } from '@/lib/invoiceBuild'
import { formatPhone } from '@/lib/utils'
import type { CustomerRecord } from '@/types/tms'
import type { TmsTone } from '@/features/tms/kit'
import { billingEmailsOf } from '../sections/fieldUtil'
import type { CardProps } from './cardRegistry'
import { creditWarning, formatAddress, requirementChips, termsText } from './billToModel'
import { ratesSummary } from './ratesSummary'
import './billToCard.css'

const DASH = '—'

function statusTone(label: string): TmsTone {
  if (label === 'CREDIT HOLD' || label === 'BLOCKED' || label === 'CLOSED') return 'red'
  if (label === 'ACTIVE') return 'green'
  if (label === 'DORMANT' || label === 'PENDING') return 'orange'
  return 'gray'
}

function Item({ label, testId, children, legacyId }: { label: string; testId: string; children: React.ReactNode; legacyId?: string }) {
  return (
    <div className="tms-card-billto-item">
      <dt className="tms-card-billto-label">{label}</dt>
      <dd className="tms-card-billto-value" data-testid={testId}>
        {legacyId ? <span data-testid={legacyId}>{children}</span> : children}
      </dd>
    </div>
  )
}

function Filled({ customer, props }: { customer: CustomerRecord; props: CardProps }) {
  const { values, ctx } = props
  const settings = ctx.settings
  const billToId = values.customer.billToId
  const { orders, shipments, loads, loading } = useCustomerOrders(customer.id, customer)
  const summary = useMemo(
    () => creditSummaryForCustomer(customer, settings, { orders, shipments, loads }),
    [customer, settings, orders, shipments, loads],
  )
  const total = useMemo(() => ratesSummary(values, customer, settings).customerTotalCents, [values, customer, settings])

  const parties = customer.billToParties ?? []
  const party = parties.find((b) => b.id === billToId) ?? null
  const termsDays = party?.paymentTermsDays ?? customer.paymentTermsDays ?? null
  const limit = summary.policy.creditLimitCents
  const available = loading ? null : summary.availableCents
  const emails = billingEmailsOf(customer, billToId)
  const address = formatAddress(party?.address ?? customer.billingAddress)
  const contact = [customer.billingContactName, (party?.phone ?? customer.billingPhone) ? formatPhone((party?.phone ?? customer.billingPhone) as string) : ''].filter(Boolean).join(' · ')
  const factored = customer.factored === true
  const noa = (settings?.factorRemitTo?.noticeText ?? '').trim() !== ''
  const onHold = customer.creditHoldFlag === true
  const statusLabel = onHold ? 'CREDIT HOLD' : (customer.status ?? 'ACTIVE')
  const warning = loading && !onHold ? null : creditWarning(onHold, available, total)
  const chips = requirementChips(customer, settings)

  return (
    <div className="tms-card-billto" role="group" aria-label="Bill To" data-testid="f-customer-billToBlock">
      <div className="tms-card-billto-head">
        <TmsBadge tone={statusTone(statusLabel)} data-testid="card-billTo-status">{statusLabel}</TmsBadge>
        <Link className="ship-link" to={`/tms/customers/${customer.id}`} data-testid="card-billTo-open">Open customer</Link>
      </div>
      {warning && (
        <div className="tms-card-billto-warn" role="alert" data-testid="card-billTo-creditWarn">
          {warning.kind === 'hold'
            ? 'Credit hold: this customer is on hold. Check with accounting before booking.'
            : `Credit hold risk: this shipment (${formatCents(warning.totalCents)}) exceeds available credit (${formatCents(warning.availableCents)}).`}
        </div>
      )}
      <dl className="tms-card-billto-grid">
        <Item label="Bill-to name & address" testId="card-billTo-party">
          <strong>{party?.name ?? customer.name}</strong>
          <span className="tms-card-billto-sub">{address || DASH}</span>
        </Item>
        <Item label="Payment terms" testId="card-billTo-terms" legacyId="f-customer-billTo-terms">{termsText(termsDays)}</Item>
        <Item label="Credit limit" testId="card-billTo-limit" legacyId="f-customer-billTo-limit">{limit === null ? 'No limit set' : formatCents(limit)}</Item>
        <Item label="Open AR" testId="card-billTo-openAr">{loading ? '…' : formatCents(summary.byBucket.INVOICED)}</Item>
        <Item label="Available credit" testId="card-billTo-available" legacyId="f-customer-billTo-available">
          {limit === null ? DASH : loading || summary.availableCents === null ? '…' : formatCents(summary.availableCents)}
        </Item>
        <Item label="Factoring" testId="card-billTo-factoring">
          <span data-testid="f-customer-billTo-factoring">{factored ? 'Factored via OTR' : 'Not factored'}</span>
          <span className="tms-card-billto-sub" data-testid="card-billTo-noa">
            {factored ? (noa ? 'Notice of assignment on invoices' : 'No notice of assignment set') : DASH}
          </span>
        </Item>
        <Item label="Billing e-mails" testId="card-billTo-emails" legacyId="f-customer-billTo-emails">{emails.length > 0 ? emails.join(', ') : DASH}</Item>
        <Item label="Billing contact" testId="card-billTo-contact">{contact || DASH}</Item>
        <Item label="Invoicing requirements" testId="card-billTo-requirements">
          {chips.length === 0 ? 'None' : (
            <span className="tms-card-billto-chips">
              {chips.map((c) => <span key={c} className="tms-card-billto-chip" data-testid="card-billTo-chip">{c}</span>)}
            </span>
          )}
        </Item>
      </dl>
    </div>
  )
}

function BillToCardImpl(props: CardProps) {
  const customer = props.ctx.customer
  if (!customer) {
    return <p className="tms-card-billto-empty" data-testid="card-billTo-empty">Choose a customer to see billing details</p>
  }
  return <Filled key={customer.id} customer={customer} props={props} />
}

export const BillToCard = memo(BillToCardImpl)
