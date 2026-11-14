/**
 * Needs review (Ryne 2026-11-13): shipments AR/AP should check before trusting their numbers, each
 * with the reason it was flagged. The same list sits on the Invoicing (AR) and Payables (AP) pages;
 * the carrier note (`financeReviewApNote`, carrier pay) is shown on the AP page only.
 */
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsButton, TmsInput, TmsTable, type ColumnDef } from '@/features/tms/kit'
import { financeAction, setDeliveredDate, type FinanceReviewShipment } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'
import { formatDateShort } from '@/lib/date'
import { shipmentEditorPath } from '@/lib/shipmentLinks'

interface Props {
  rows: FinanceReviewShipment[]
  error: string | null
  /** AP page: also show the carrier note (carrier pay is internal to AP). */
  side: 'AR' | 'AP'
  onCleared: () => void
}

export function NeedsReviewList({ rows, error, side, onCleared }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => [row.number, row.customerName, row.financeReviewReason, side === 'AP' ? row.financeReviewApNote : null]
      .some((v) => v != null && String(v).toLowerCase().includes(q)))
  }, [rows, search, side])
  const clear = (row: FinanceReviewShipment) => {
    setBusy(row.id)
    financeAction('CLEAR_FINANCE_REVIEW', { shipmentId: row.id })
      .then(() => { toast.success(`PRO ${row.number ?? row.id} cleared from Needs review`); onCleared() })
      .catch((e: unknown) => toast.error(errorText(e) || 'Could not clear the flag'))
      .finally(() => setBusy(null))
  }
  const [editing, setEditing] = useState<{ id: string; day: string } | null>(null)
  const saveDelivered = (row: FinanceReviewShipment, day: string) => {
    if (!day) { toast.error('Pick the delivered date'); return }
    setBusy(row.id)
    setDeliveredDate({ shipmentId: row.id, deliveredDate: day })
      .then((r) => {
        const extra = [r.reviewCleared ? 'cleared from Needs review' : '', r.redatedBills ? `${r.redatedBills} carrier bill${r.redatedBills === 1 ? '' : 's'} due 2 days after delivery` : ''].filter(Boolean).join(' · ')
        toast.success(`PRO ${row.number ?? row.id} delivered ${formatDateShort(r.deliveredAt)}${extra ? ` · ${extra}` : ''}`)
        setEditing(null)
        onCleared()
      })
      .catch((e: unknown) => toast.error(errorText(e) || 'Could not save the delivered date'))
      .finally(() => setBusy(null))
  }
  const deliveredCell = (row: FinanceReviewShipment) => {
    if (editing?.id === row.id) {
      return (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <TmsInput type="date" aria-label={`Delivered date for PRO ${row.number ?? row.id}`} value={editing.day} onChange={(e) => setEditing({ id: row.id, day: e.target.value })} />
          <TmsButton size="sm" variant="primary" disabled={busy === row.id} onClick={() => saveDelivered(row, editing.day)}>Save</TmsButton>
          <TmsButton size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</TmsButton>
        </span>
      )
    }
    const missing = !row.deliveredAt
    return (
      <span className="flex items-center gap-1 whitespace-nowrap">
        {missing ? <span style={{ color: 'var(--tms-badge-red)' }}>Missing</span> : formatDateShort(row.deliveredAt as string)}
        <TmsButton size="sm" variant={missing ? 'primary' : 'ghost'} aria-label={`Edit delivered date for PRO ${row.number ?? row.id}`}
          onClick={() => setEditing({ id: row.id, day: row.deliveredAt ? chicagoDay(row.deliveredAt) : '' })}>{missing ? 'Add' : 'Edit'}</TmsButton>
      </span>
    )
  }
  const columns: ColumnDef<FinanceReviewShipment>[] = [
    { key: 'pro', header: 'PRO', render: (row) => <Link to={shipmentEditorPath(row.id)}>{row.number ?? row.id}</Link>, text: (row) => String(row.number ?? '') },
    { key: 'customer', header: 'Customer', render: (row) => row.customerName ?? '—', text: (row) => row.customerName ?? '' },
    { key: 'reason', header: 'Reason', render: (row) => row.financeReviewReason ?? '—', text: (row) => row.financeReviewReason ?? '' },
    ...(side === 'AP'
      ? [{ key: 'apNote', header: 'Carrier note', render: (row: FinanceReviewShipment) => row.financeReviewApNote ?? '—', text: (row: FinanceReviewShipment) => row.financeReviewApNote ?? '' }]
      : []),
    { key: 'delivered', header: 'Delivered', render: deliveredCell, text: (row) => row.deliveredAt ?? '' },
    { key: 'flagged', header: 'Flagged', render: (row) => (row.financeReviewAt ? formatDateShort(row.financeReviewAt) : '—'), text: (row) => row.financeReviewAt ?? '' },
    { key: 'clear', header: '', render: (row) => <TmsButton size="sm" variant="ghost" disabled={busy === row.id} onClick={() => clear(row)}>Mark reviewed</TmsButton> },
  ]
  return (
    <div data-testid={`needs-review-${side.toLowerCase()}`}>
      {error && <p style={{ color: 'var(--tms-badge-red)' }} className="text-sm">{error}</p>}
      <div className="tms-dense-bar">
        <Search size={14} className="tms-muted" aria-hidden="true" />
        <TmsInput className="tms-dense-search" aria-label="Search" data-testid={`needs-review-search-${side.toLowerCase()}`}
          placeholder={side === 'AP' ? 'Search PRO, customer, carrier note…' : 'Search PRO, customer, reason…'}
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="tms-muted">{shown.length === rows.length ? `${rows.length} rows` : `${shown.length} of ${rows.length} rows`}</span>
      </div>
      <TmsTable columns={columns} rows={shown} rowKey={(row) => row.id} empty="Nothing needs review." />
    </div>
  )
}

const chicagoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
/** The delivered day as the date input wants it, read in Chicago like the backend. */
function chicagoDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : chicagoFmt.format(d)
}
