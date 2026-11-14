/**
 * The invoice row in the shipment rail's money block: where this load's invoice stands (Ready to invoice,
 * Factoring pending, OTR rejected, Outstanding, Partially paid, Paid …), the same word the All Shipments
 * board and the AR tab use (`loadInvoiceStatusOf`). It reads the invoice and the OTR queue row once per
 * change of id; until they answer (or if they cannot be read) the order's cached AR fields decide.
 * Internal only: it shows the invoice's own balance, never carrier pay.
 */
import { memo, useEffect, useState } from 'react'
import { TmsBadge } from '@/features/tms/kit'
import { getFactoringItem, getInvoice } from '@/lib/apiClient'
import { formatBoardDate } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { loadInvoiceStatusOf, loadInvoiceStatusText } from '@/lib/loadInvoiceStatus'
import type { FactoringItem } from '@/types'
import type { InvoiceRecord, ShipmentBundle } from '@/types/tms'

function RailInvoiceStatusImpl({ bundle }: { bundle: ShipmentBundle | null }) {
  const order = bundle?.orders[0] ?? null
  const invoiceId = order?.invoiceId ?? null
  const [invoice, setInvoice] = useState<{ id: string; row: InvoiceRecord | null } | null>(null)
  const [item, setItem] = useState<{ id: string; row: FactoringItem | null } | null>(null)

  useEffect(() => {
    if (!invoiceId) return undefined
    let live = true
    getInvoice(invoiceId).then((row) => { if (live) setInvoice({ id: invoiceId, row }) }).catch(() => { /* cached fields decide */ })
    return () => { live = false }
  }, [invoiceId])

  const liveInvoice = invoice && invoice.id === invoiceId ? invoice.row : null
  const itemId = order?.factoringItemId ?? liveInvoice?.factoringItemId ?? null
  useEffect(() => {
    if (!itemId) return undefined
    let live = true
    getFactoringItem(itemId).then((row) => { if (live) setItem({ id: itemId, row }) }).catch(() => { /* no factoring access: cached fields decide */ })
    return () => { live = false }
  }, [itemId])

  if (!order) return null
  const liveItem = item && item.id === itemId ? item.row : null
  const status = loadInvoiceStatusOf(order, liveInvoice, liveItem)
  const balance = liveInvoice?.balanceCents ?? order.arBalanceCents ?? null
  const showBalance = balance != null && (status.key === 'OUTSTANDING' || status.key === 'PARTIAL')

  return (
    <div className="tms-rail-money-row" data-testid="rail-invoice-status" style={{ flexWrap: 'wrap' }}>
      <span>Invoice</span>
      <span className="flex items-center gap-1">
        <TmsBadge tone={status.tone} title={status.reason ?? undefined}>{loadInvoiceStatusText(status, formatBoardDate)}</TmsBadge>
        {showBalance ? <span className="tms-muted text-xs" data-testid="rail-invoice-balance">{formatCents(balance)} open</span> : null}
      </span>
      {status.reason ? <p className="tms-rail-line tms-muted text-xs" data-testid="rail-invoice-reason" style={{ flexBasis: '100%' }}>{status.reason}</p> : null}
    </div>
  )
}

export const RailInvoiceStatus = memo(RailInvoiceStatusImpl)
