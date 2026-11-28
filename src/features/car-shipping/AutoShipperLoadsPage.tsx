/**
 * `/auto-shipper-loads` — CAR SHIPPING → Auto Shipper Loads (Ryne 2026-11-27). Every shipment of the AUTO SHIPPER customer, with
 * what the customer still owes and what each carrier is owed, so the office sees at a glance which loads have money outstanding
 * and which carriers need paying or have been paid. Carrier payment still runs through Accounts Payable: the carrier cell opens
 * the recorded bill (or the shipment's Carrier Pay tab when no bill is recorded yet). Nothing is paid from here: the row buttons
 * (Mark paid, Pay carrier) open Payments Received or Accounts Payable on that invoice or bill, where the money is recorded.
 *
 * Money follows the grants: the customer columns and tiles need the Accounts Receivable grant, the carrier ones the Accounts
 * Payable grant, and a person limited to the fleet profiles (Jason) sees neither.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import './autoShipperLoads.css'
import { Link } from 'react-router-dom'
import { Download, RefreshCw } from 'lucide-react'
import { TmsBadge, TmsSegmentedTabs, TmsSelect } from '@/features/tms/kit'
import type { TmsTone } from '@/features/tms/kit/statusTone'
import { ArDenseTable, type ArColumn } from '@/features/ar/components/ArDenseTable'
import { DenseKpiStrip, type DenseKpi } from '@/features/tms/grid/DenseControls'
import { useAuth } from '@/hooks/useAuth'
import { isFleetProfilesOnly } from '@/lib/profileAccess'
import { chicagoDateStr } from '@/lib/date'
import { downloadCsv } from '@/lib/directoryCsv'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDay } from '@/features/ar/arViews'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import { useAutoShipperLoads } from './useAutoShipperLoads'
import { SquareSendDialog } from './SquareSendDialog'
import { useShipmentActions } from './useShipmentActions'
import {
  AUTO_SHIPPER_TABS, CARRIER_PAY_LABEL, CARRIER_ROLLUP_LABEL, CUSTOMER_PAY_LABEL, DATE_RANGE_OPTIONS,
  autoShipperCsv, carrierAction, carrierPayCents, carrierPayTotal, customerAction, inRange, inTab, shipmentAction, summarize, tabCounts,
  type AutoShipperRow, type AutoShipperTab, type CarrierPayState, type CustomerPayState, type DateRangeKey,
} from './autoShipperLoads'

const CUSTOMER_TONE: Record<CustomerPayState, TmsTone> = { NOT_INVOICED: 'gray', UNPAID: 'orange', PARTIAL: 'orange', PAID: 'green' }
const CARRIER_TONE: Record<CarrierPayState, TmsTone> = {
  NO_BILL: 'gray', BILL_RECORDED: 'blue', APPROVED: 'purple', SCHEDULED: 'turquoise', PARTIAL: 'orange', PAID: 'green', OWN_TRUCK: 'gray',
}

const money = (cents: number | null | undefined): string => (cents == null ? '' : formatCents(cents))

/** Where a carrier cell goes: the recorded bill in Accounts Payable, else the shipment's Carrier Pay tab. */
function carrierLink(row: AutoShipperRow, billId: string | null): string {
  return billId ? `/tms/invoicing/payable/bills/${encodeURIComponent(billId)}` : `${shipmentEditorPath(row.id)}?tab=carrierPay`
}

export function AutoShipperLoadsPage() {
  const auth = useAuth()
  const limited = isFleetProfilesOnly(auth.user?.email, auth.user?.groups)
  const showAr = !limited && auth.hasPageAccess('invoicing')
  const showAp = !limited && auth.hasPageAccess('carrierPay')
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  const { rows, loading, error, refresh } = useAutoShipperLoads({ asOf, showAr, showAp })
  const [tab, setTab] = useState<AutoShipperTab>('all')
  const [range, setRange] = useState<DateRangeKey>('all')
  const [shown, setShown] = useState<AutoShipperRow[]>([])
  const [confirmSend, setConfirmSend] = useState<AutoShipperRow | null>(null)
  const { busyId, run: runAction } = useShipmentActions(refresh)

  const inRangeRows = useMemo(() => rows.filter((r) => inRange(r, range, asOf)), [rows, range, asOf])
  const counts = useMemo(() => tabCounts(inRangeRows), [inRangeRows])
  const summary = useMemo(() => summarize(inRangeRows), [inRangeRows])
  const tabs = useMemo(() => AUTO_SHIPPER_TABS
    .filter((t) => t.key === 'all'
      || (t.key === 'customer-unpaid' && showAr)
      || (t.key === 'carrier-unpaid' && showAp)
      || (t.key === 'paid' && showAr && showAp))
    .map((t) => ({ key: t.key, label: `${t.label} (${counts[t.key]})`, title: t.title })), [showAr, showAp, counts])
  const activeTab = tabs.some((t) => t.key === tab) ? tab : 'all'
  const listed = useMemo(() => inRangeRows.filter((r) => inTab(r, activeTab)), [inRangeRows, activeTab])

  const carrierTotal = useMemo(() => carrierPayTotal(listed), [listed])

  const kpis = useMemo<DenseKpi[]>(() => {
    const out: DenseKpi[] = []
    if (showAr) {
      out.push({
        label: 'Customers owe', value: `${money(summary.customersOwe.cents)} · ${summary.customersOwe.count} loads`,
        tone: summary.customersOwe.count > 0 ? 'warn' : 'good', onClick: () => setTab('customer-unpaid'), active: activeTab === 'customer-unpaid',
        title: 'Open invoices plus the price of loads not invoiced yet',
      })
      out.push({ label: 'Not invoiced yet', value: String(summary.notInvoiced), tone: summary.notInvoiced > 0 ? 'warn' : undefined })
    }
    if (showAp) {
      out.push({
        label: 'Carriers to pay', value: `${money(summary.carriersToPay.cents)} · ${summary.carriersToPay.count} loads`,
        tone: summary.carriersToPay.count > 0 ? 'warn' : 'good', onClick: () => setTab('carrier-unpaid'), active: activeTab === 'carrier-unpaid',
        title: 'Delivered loads with a carrier still unpaid',
      })
      out.push({ label: 'Carriers paid', value: `${summary.carriersPaid} loads`, tone: 'good' })
      out.push({
        label: 'Carrier pay', value: `${money(carrierTotal.cents)} · ${carrierTotal.count} loads`,
        title: 'What the carriers on the rows listed below are paid in all, paid or not',
      })
    }
    return out
  }, [showAr, showAp, summary, activeTab, carrierTotal])

  const columns = useMemo<Array<ArColumn<AutoShipperRow>>>(() => {
    const cols: Array<ArColumn<AutoShipperRow>> = [
      { key: 'pro', header: 'PRO', text: (r) => r.pro, group: 'Shipment', width: 90 },
      { key: 'payer', header: 'Payer', text: (r) => r.payer, group: 'Shipment' },
      { key: 'pickup', header: 'Pickup', text: (r) => formatDay(r.pickup), dateOf: (r) => r.pickup, filter: 'date', group: 'Shipment' },
      { key: 'delivery', header: 'Delivery', text: (r) => formatDay(r.delivery), dateOf: (r) => r.delivery, filter: 'date', group: 'Shipment' },
      { key: 'route', header: 'Route', text: (r) => r.route, group: 'Shipment' },
      { key: 'vehicle', header: 'Vehicle', text: (r) => r.vehicle, group: 'Shipment' },
      { key: 'status', header: 'Shipment status', text: (r) => r.status.replace(/_/g, ' ').toLowerCase(), group: 'Shipment', filter: 'multi' },
      { key: 'shipmentAction', header: 'Shipment action', text: (r) => shipmentAction(r, showAr)?.label ?? '', extraPx: 150, group: 'Shipment' },
    ]
    if (showAr) {
      cols.push(
        { key: 'price', header: 'Customer price', text: (r) => money(r.priceCents), numberOf: (r) => (r.priceCents ?? 0) / 100, filter: 'number', align: 'right', group: 'Customer' },
        {
          key: 'customerPay', header: 'Customer payment', text: (r) => (r.customer ? CUSTOMER_PAY_LABEL[r.customer.state] : ''), filter: 'multi',
          extraPx: 150, group: 'Customer',
        },
        { key: 'owed', header: 'Customer owes', text: (r) => money(r.customer?.owedCents), numberOf: (r) => (r.customer?.owedCents ?? 0) / 100, filter: 'number', align: 'right', group: 'Customer' },
        {
          key: 'customerAction', header: 'Customer action', text: (r) => customerAction(r)?.label ?? '', extraPx: 120, group: 'Customer',
        },
        { key: 'days', header: 'Days outstanding', text: (r) => (r.customer?.daysOutstanding == null ? '' : String(r.customer.daysOutstanding)), numberOf: (r) => r.customer?.daysOutstanding ?? null, filter: 'number', align: 'right', group: 'Customer' },
      )
    }
    if (showAp) {
      cols.push(
        { key: 'carrier', header: 'Carrier', text: (r) => (r.carriers ?? []).map((c) => c.carrierName).join(', ') || CARRIER_ROLLUP_LABEL.NO_CARRIER, group: 'Carrier' },
        {
          key: 'carrierAmount', header: 'Carrier pay', text: (r) => (r.carriers ?? []).map((c) => money(c.amountCents)).filter(Boolean).join(', '),
          numberOf: (r) => { const c = carrierPayCents(r); return c == null ? null : c / 100 }, filter: 'number', align: 'right', group: 'Carrier',
        },
        {
          key: 'carrierPay', header: 'Carrier payment', text: (r) => (r.carrierRollup ? CARRIER_ROLLUP_LABEL[r.carrierRollup] : ''), filter: 'multi',
          optionsOf: (r) => (r.carriers && r.carriers.length ? r.carriers.map((c) => ({ value: CARRIER_PAY_LABEL[c.state], label: CARRIER_PAY_LABEL[c.state] })) : [{ value: CARRIER_ROLLUP_LABEL.NO_CARRIER, label: CARRIER_ROLLUP_LABEL.NO_CARRIER }]),
          extraPx: 150, group: 'Carrier',
        },
        {
          key: 'carrierAction', header: 'Carrier action', text: (r) => (r.carriers ?? []).map((c) => carrierAction(c, r.id)?.label ?? '').filter(Boolean).join(', '),
          extraPx: 120, group: 'Carrier',
        },
        { key: 'payTo', header: 'Pay to', text: (r) => (r.carriers ?? []).map((c) => c.payTo ?? '').filter(Boolean).join(', '), group: 'Carrier' },
      )
    }
    return cols
  }, [showAr, showAp])

  const renderCell = useCallback((row: AutoShipperRow, key: string): ReactNode => {
    if (key === 'pro') return <Link to={shipmentEditorPath(row.id)} onClick={(e) => e.stopPropagation()}>{row.pro}</Link>
    if (key === 'customerPay' && row.customer) {
      const c = row.customer
      return (
        <span className="asl-chips">
          <TmsBadge tone={CUSTOMER_TONE[c.state]}>{CUSTOMER_PAY_LABEL[c.state]}</TmsBadge>
          {c.invoiceNumber ? <span className="asl-sub">{c.invoiceNumber}</span> : null}
          {c.squareLabel ? <TmsBadge tone="gray" title="Square invoice status">Square: {c.squareLabel}</TmsBadge> : null}
        </span>
      )
    }
    if (key === 'shipmentAction') {
      const a = shipmentAction(row, showAr)
      if (!a) return undefined
      return (
        <button
          type="button"
          className="tms-btn tms-btn-secondary tms-btn-sm"
          data-testid={`asl-shipment-action-${row.pro}`}
          disabled={busyId != null}
          title={a.title}
          onClick={(e) => {
            e.stopPropagation()
            if (a.kind === 'SEND_INVOICE') setConfirmSend(row)
            else void runAction(a.kind, row.id)
          }}
        >
          {busyId === row.id ? 'Working…' : a.label}
        </button>
      )
    }
    if (key === 'customerAction') {
      const a = customerAction(row)
      if (!a) return undefined
      return (
        <span className="asl-chips" data-testid={`asl-customer-action-${row.pro}`}>
          {a.to
            ? <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={a.to} onClick={(e) => e.stopPropagation()}
              title="Open Payments Received on this invoice and record the payment there">{a.label}</Link>
            : <span className="asl-sub" title={a.note ?? undefined}>{a.label}</span>}
          {a.helpTo ? <Link className="asl-sub" to={a.helpTo} onClick={(e) => e.stopPropagation()} title="Open Receivables on Ready to invoice">{a.helpLabel}</Link> : null}
        </span>
      )
    }
    if (key === 'carrierAction' && row.carriers) {
      const actions = row.carriers.map((c) => ({ c, a: carrierAction(c, row.id) })).filter((x) => x.a)
      if (actions.length === 0) return undefined
      return (
        <span className="asl-chips" data-testid={`asl-carrier-action-${row.pro}`}>
          {actions.map(({ c, a }) => (
            <Link key={c.legId} className="tms-btn tms-btn-secondary tms-btn-sm" to={a!.to!} onClick={(e) => e.stopPropagation()}
              title={a!.note ?? `Open Accounts Payable on this carrier bill: ${c.carrierName}`}>
              {actions.length > 1 ? `${a!.label}: ${c.carrierName}` : a!.label}
            </Link>
          ))}
        </span>
      )
    }
    if (key === 'carrier' && row.carriers) {
      if (row.carriers.length === 0) return <span className="asl-sub">{CARRIER_ROLLUP_LABEL.NO_CARRIER}</span>
      return (
        <span className="asl-chips">
          {row.carriers.map((c) => (
            c.state === 'OWN_TRUCK'
              ? <span key={c.legId}>{c.carrierName}</span>
              : <Link key={c.legId} to={carrierLink(row, c.billId)} onClick={(e) => e.stopPropagation()}
                title={`${c.billId ? 'Open this carrier bill in Accounts Payable' : 'Open the shipment to record the carrier bill'}${c.amountCents != null ? ` · ${money(c.amountCents)}` : ''}`}>
                {row.carriers!.length > 1 && c.amountCents != null ? `${c.carrierName} ${money(c.amountCents)}` : c.carrierName}
              </Link>
          ))}
        </span>
      )
    }
    if (key === 'carrierPay' && row.carriers) {
      if (row.carriers.length === 0) return <TmsBadge tone="gray">{CARRIER_ROLLUP_LABEL.NO_CARRIER}</TmsBadge>
      return (
        <span className="asl-chips">
          {row.carriers.map((c) => (
            <span key={c.legId} className="asl-chips" title={c.amountCents != null && c.state !== 'OWN_TRUCK' ? `${c.carrierName}: ${money(c.amountCents)} carrier pay` : undefined}>
              <TmsBadge tone={CARRIER_TONE[c.state]}>{CARRIER_PAY_LABEL[c.state]}</TmsBadge>
              {c.state === 'PAID' && c.paidAt ? <span className="asl-sub">{formatDay(c.paidAt.slice(0, 10))}</span> : null}
              {c.state !== 'PAID' && c.state !== 'OWN_TRUCK' && c.owedCents > 0 ? <span className="asl-sub">{money(c.owedCents)}</span> : null}
            </span>
          ))}
        </span>
      )
    }
    return undefined
  }, [showAr, busyId, runAction])

  const exportCsv = () => {
    const rowsOut = shown.length > 0 || listed.length === 0 ? shown : listed
    downloadCsv(`auto-shipper-loads-${asOf}.csv`, autoShipperCsv(rowsOut, { showAr, showAp }))
  }
  const rangeLabel = DATE_RANGE_OPTIONS.find((o) => o.key === range)?.label ?? ''

  return (
    <div className="tms-page" data-testid="auto-shipper-loads-page">
      <div className="tms-page-head">
        <h1>Auto Shipper Loads</h1>
        <div className="tms-page-actions">
          <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Refresh" onClick={() => { void refresh() }}>
            <RefreshCw size={15} />
          </button>
          <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Export CSV" title="Export the rows listed as a CSV" data-testid="auto-shipper-csv" onClick={exportCsv}>
            <Download size={15} />
          </button>
        </div>
      </div>

      <div className="asl-toolbar" data-testid="auto-shipper-filters">
        <TmsSegmentedTabs aria-label="Show" size="sm" active={activeTab} onSelect={(k) => setTab(k as AutoShipperTab)} tabs={tabs} />
        <TmsSelect aria-label="Pickup dates" value={range} onChange={(e) => setRange(e.target.value as DateRangeKey)}>
          {DATE_RANGE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </TmsSelect>
      </div>
      {!showAr && !showAp && <p className="asl-note">Your access shows the loads only. Customer and carrier payments need the Accounts Receivable and Accounts Payable grants.</p>}
      {kpis.length > 0 && <DenseKpiStrip open items={kpis} variant="cards" />}
      {error && <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}

      <ArDenseTable<AutoShipperRow>
        key={`${activeTab}-${range}`}
        grid={{
          gridId: 'auto-shipper-loads',
          label: 'Auto Shipper Loads',
          columns,
          rows: listed,
          rowKey: (r) => r.id,
          renderCell,
          onFiltered: setShown,
          defaultColumns: ['pro', 'payer', 'pickup', 'route', 'vehicle', 'shipmentAction', ...(showAr ? ['price', 'customerPay', 'owed', 'customerAction'] : []), ...(showAp ? ['carrier', 'carrierAmount', 'carrierPay', 'carrierAction', 'payTo'] : [])],
          introduceColumns: [{ key: 'shipmentAction', after: 'vehicle' }, ...(showAp ? [{ key: 'carrierAmount', after: 'carrier' }] : [])],
          cardLayout: { title: 'pro', party: 'payer', amount: showAr ? 'owed' : 'route', pills: [...(showAr ? ['customerPay'] : []), ...(showAp ? ['carrierPay'] : [])] },
          empty: loading ? 'Loading…' : error ? 'The loads could not load. Refresh to try again.' : `No auto shipper loads for ${rangeLabel.toLowerCase()}.`,
        }}
      />
      {confirmSend && (
        <SquareSendDialog
          target={{ pro: confirmSend.pro, payer: confirmSend.payer, payerEmail: confirmSend.payerEmail, amountCents: confirmSend.priceCents }}
          busy={busyId != null}
          onCancel={() => setConfirmSend(null)}
          onConfirm={() => { const row = confirmSend; setConfirmSend(null); void runAction('SEND_INVOICE', row.id) }}
        />
      )}
    </div>
  )
}
