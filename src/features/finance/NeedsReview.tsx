/**
 * Needs review (Ryne 2026-11-13): shipments AR/AP should check before trusting their numbers, each
 * with the reason it was flagged. The same list sits on the Invoicing (AR) and Payables (AP) pages;
 * the carrier note (`financeReviewApNote`, carrier pay) is shown on the AP page only.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsButton, TmsTable, type ColumnDef } from '@/features/tms/kit'
import { financeAction, type FinanceReviewShipment } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'
import { formatDateShort } from '@/lib/date'

interface Props {
  rows: FinanceReviewShipment[]
  error: string | null
  /** AP page: also show the carrier note (carrier pay is internal to AP). */
  side: 'AR' | 'AP'
  onCleared: () => void
}

export function NeedsReviewList({ rows, error, side, onCleared }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const clear = (row: FinanceReviewShipment) => {
    setBusy(row.id)
    financeAction('CLEAR_FINANCE_REVIEW', { shipmentId: row.id })
      .then(() => { toast.success(`PRO ${row.number ?? row.id} cleared from Needs review`); onCleared() })
      .catch((e: unknown) => toast.error(errorText(e) || 'Could not clear the flag'))
      .finally(() => setBusy(null))
  }
  const columns: ColumnDef<FinanceReviewShipment>[] = [
    { key: 'pro', header: 'PRO', render: (row) => <Link to={`/tms/shipments/${row.id}`}>{row.number ?? row.id}</Link>, text: (row) => String(row.number ?? '') },
    { key: 'customer', header: 'Customer', render: (row) => row.customerName ?? '—', text: (row) => row.customerName ?? '' },
    { key: 'reason', header: 'Reason', render: (row) => row.financeReviewReason ?? '—', text: (row) => row.financeReviewReason ?? '' },
    ...(side === 'AP'
      ? [{ key: 'apNote', header: 'Carrier note', render: (row: FinanceReviewShipment) => row.financeReviewApNote ?? '—', text: (row: FinanceReviewShipment) => row.financeReviewApNote ?? '' }]
      : []),
    { key: 'flagged', header: 'Flagged', render: (row) => (row.financeReviewAt ? formatDateShort(row.financeReviewAt) : '—'), text: (row) => row.financeReviewAt ?? '' },
    { key: 'clear', header: '', render: (row) => <TmsButton size="sm" variant="ghost" disabled={busy === row.id} onClick={() => clear(row)}>Mark reviewed</TmsButton> },
  ]
  return (
    <div data-testid={`needs-review-${side.toLowerCase()}`}>
      {error && <p style={{ color: 'var(--tms-badge-red)' }} className="text-sm">{error}</p>}
      <TmsTable columns={columns} rows={rows} rowKey={(row) => row.id} empty="Nothing needs review." />
    </div>
  )
}
