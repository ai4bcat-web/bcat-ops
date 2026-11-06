/**
 * The header's Bill To (Step AR feedback 7, built from the feedback-2 card). A summary chip in the
 * strip (bill-to name · terms · factored · available credit, amber on credit hold) with a Details
 * chevron, and the full panel under the strip, collapsed by default: the read-only billing detail
 * (bill-to party and address, terms, credit limit / open AR / available credit, factoring and
 * notice of assignment, billing contacts, invoicing requirements, status badge, credit-hold strip)
 * beside the editable Customer contact column (Ref #, contact, phone, two e-mails, bill-to party).
 * The panel stays mounted (hidden) so its fields keep their test ids and can be focused.
 *
 * No new reads: credit comes from `useCustomerOrders` (the same per-customer read the AH block
 * and the Customers profile use); Open AR is its INVOICED bucket (billed, unpaid). The
 * whole-table `CRM_LIST_ACCOUNTS` read is deliberately not used here.
 */
import { ChevronDown } from 'lucide-react'
import { useMemo } from 'react'
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
import { CustomerContact } from './CustomerCard'
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

function BillToDetail({ customer, d }: { customer: CustomerRecord; d: BillToData }) {
  const { settings, loading, summary, party, termsDays, limit, emails, address, contact, factored, statusLabel, warning } = d
  const noa = (settings?.factorRemitTo?.noticeText ?? '').trim() !== ''
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

interface BillToData {
  settings: CardProps['ctx']['settings']
  loading: boolean
  summary: ReturnType<typeof creditSummaryForCustomer>
  party: NonNullable<CustomerRecord['billToParties']>[number] | null
  termsDays: number | null
  limit: number | null
  available: number | null
  emails: string[]
  address: string
  contact: string
  factored: boolean
  onHold: boolean
  statusLabel: string
  warning: ReturnType<typeof creditWarning>
}

function useBillToData(customer: CustomerRecord, props: CardProps): BillToData {
  const { values, ctx } = props
  const settings = ctx.settings
  const billToId = values.customer.billToId
  const { orders, shipments, loads, loading } = useCustomerOrders(customer.id, customer)
  const summary = useMemo(
    () => creditSummaryForCustomer(customer, settings, { orders, shipments, loads }),
    [customer, settings, orders, shipments, loads],
  )
  const total = useMemo(() => ratesSummary(values, customer, settings).customerTotalCents, [values, customer, settings])
  const party = (customer.billToParties ?? []).find((b) => b.id === billToId) ?? null
  const phone = party?.phone ?? customer.billingPhone
  const onHold = customer.creditHoldFlag === true
  const available = loading ? null : summary.availableCents
  return {
    settings, loading, summary, party,
    termsDays: party?.paymentTermsDays ?? customer.paymentTermsDays ?? null,
    limit: summary.policy.creditLimitCents,
    available,
    emails: billingEmailsOf(customer, billToId),
    address: formatAddress(party?.address ?? customer.billingAddress),
    contact: [customer.billingContactName, phone ? formatPhone(phone) : ''].filter(Boolean).join(' · '),
    factored: customer.factored === true,
    onHold,
    statusLabel: onHold ? 'CREDIT HOLD' : (customer.status ?? 'ACTIVE'),
    warning: loading && !onHold ? null : creditWarning(onHold, available, total),
  }
}

export interface BillToStripProps extends CardProps {
  open: boolean
  onToggle: () => void
}

function Chip({ text, hold, open, onToggle, empty }: { text: string; hold: boolean; open: boolean; onToggle: () => void; empty?: boolean }) {
  return (
    <div className="tms-ship-hdr-cell tms-ship-hdr-billto">
    <span className="tms-fg-label"><span className="tms-fg-label-text">Bill to</span></span>
    <button
      type="button" className="tms-ship-billto-chip" data-testid="hdr-billTo-chip" data-hold={hold} data-empty={empty === true}
      aria-expanded={open} aria-controls="ship-form-header-panel" onClick={onToggle}
    >
      <span className="tms-ship-billto-text" data-testid="hdr-billTo-text">{text}</span>
      <span className="tms-ship-billto-details">Details<ChevronDown size={14} aria-hidden="true" data-open={open} /></span>
    </button>
    </div>
  )
}

/** Data lives in ONE keyed child (one credit read) that renders the chip and the panel; CSS orders the chip into the strip. */
function Live({ customer, props, open, onToggle }: { customer: CustomerRecord; props: CardProps; open: boolean; onToggle: () => void }) {
  const d = useBillToData(customer, props)
  const credit = d.limit === null ? 'No credit limit' : d.loading || d.available === null ? 'Credit …' : `${formatCents(d.available)} available`
  const text = [d.onHold ? 'CREDIT HOLD' : null, d.party?.name ?? customer.name, termsText(d.termsDays), d.factored ? 'Factored' : 'Not factored', credit].filter(Boolean).join(' · ')
  return (
    <>
      <Chip text={text} hold={d.onHold || d.warning !== null} open={open} onToggle={onToggle} />
      <BillToPanel open={open} props={props}><BillToDetail customer={customer} d={d} /></BillToPanel>
    </>
  )
}

function BillToPanel({ open, props, children }: { open: boolean; props: CardProps; children: React.ReactNode }) {
  return (
    <div id="ship-form-header-panel" className="tms-ship-hdr-panel" data-testid="ship-form-header-panel" data-header-panel hidden={!open}>
      <div className="tms-ship-hdr-panel-col">{children}</div>
      <div className="tms-ship-hdr-panel-col">
        <h2 className="tms-ship-hdr-panel-h">Customer contact</h2>
        <CustomerContact {...props} />
      </div>
    </div>
  )
}

export function BillToStrip({ open, onToggle, ...props }: BillToStripProps) {
  const customer = props.ctx.customer
  if (!customer) {
    return (
      <>
        <Chip text="Bill To: choose a customer" hold={false} open={open} onToggle={onToggle} empty />
        <BillToPanel open={open} props={props}>
          <p className="tms-card-billto-empty" data-testid="card-billTo-empty">Choose a customer to see billing details</p>
        </BillToPanel>
      </>
    )
  }
  return <Live key={customer.id} customer={customer} props={props} open={open} onToggle={onToggle} />
}
