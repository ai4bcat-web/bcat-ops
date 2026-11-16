/**
 * Payments Received → Differences (Ryne 2026-11-16): every short pay and overpay in one table, with a bulk
 * "Accept as paid in full". Open ones (a part-paid invoice that still owes, a payment with money left over) can be
 * ticked and accepted together; ones already accepted are listed for the record.
 *
 * Accepting is confirmation-gated and read back first. Each item is applied only if its amount is still what this
 * screen shows; anything that changed is skipped and reported, never forced.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsInput } from '@/features/tms/kit'
import type { DenseColumn, DenseOption } from '@/features/tms/grid/denseGridModel'
import { ArDenseTable } from '@/features/ar/components/ArDenseTable'
import { formatDay } from '@/features/ar/arViews'
import { acceptDifferences, graphqlErrorText } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import type { CustomerRecord, InvoiceRecord } from '@/types/tms'
import {
  DIFFERENCE_KIND_LABEL, acceptItems, differenceRows, isOpenKind, selectUpTo, totalsByKind,
  type DifferenceKind, type DifferenceRow,
} from './differences'
import { parseDollars } from './outstanding'
import type { ReceivedRow } from './paymentsReceived'

const KIND_TONE: Record<DifferenceKind, 'red' | 'orange' | 'gray'> = {
  'short-open': 'red', 'over-open': 'orange', 'short-accepted': 'gray', 'over-accepted': 'gray',
}
const opt = (value: string): DenseOption[] => (value ? [{ value, label: value }] : [])
const invoicePath = (id: string) => `/tms/invoicing/invoices/${encodeURIComponent(id)}`
const KINDS = Object.keys(DIFFERENCE_KIND_LABEL) as DifferenceKind[]

export function DifferencesView({ invoices, ledger, customers, loading, customerId = null, onAccepted }: {
  invoices: InvoiceRecord[]
  ledger: ReceivedRow[]
  customers: Map<string, CustomerRecord>
  loading: boolean
  /** Work on one customer (the page's customer search). */
  customerId?: string | null
  onAccepted: () => void
}) {
  const all = useMemo(
    () => differenceRows(invoices, ledger, (id, fallback) => customers.get(id)?.name ?? fallback),
    [invoices, ledger, customers],
  )
  const base = useMemo(() => (customerId ? all.filter((r) => r.customerId === customerId) : all), [all, customerId])
  const [kindChip, setKindChip] = useState<DifferenceKind | null>(null)
  const rows = useMemo(() => (kindChip ? base.filter((r) => r.kind === kindChip) : base), [base, kindChip])
  const totals = useMemo(() => totalsByKind(base), [base])

  // What the grid leaves after its column filters, search and sort: what Select all and the bar act on.
  const [shown, setShown] = useState<DifferenceRow[]>([])
  const onFiltered = useCallback((next: DifferenceRow[]) => setShown(next), [])
  const [tickedAll, setTicked] = useState<Set<string>>(() => new Set())
  const shownOpen = useMemo(() => shown.filter((r) => isOpenKind(r.kind)), [shown])
  const shownIds = useMemo(() => new Set(shownOpen.map((r) => r.id)), [shownOpen])
  // A filter change can hide rows that were ticked: they count as unticked, so the bar can never accept them.
  const picked = useMemo(() => shownOpen.filter((r) => tickedAll.has(r.id)), [shownOpen, tickedAll])
  const allTicked = shownOpen.length > 0 && picked.length === shownOpen.length

  const [limit, setLimit] = useState('')
  const [limitError, setLimitError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [posting, setPosting] = useState(false)

  const toggle = (id: string) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const tickAll = (on: boolean) => setTicked((t) => { const n = new Set(t); for (const r of shownOpen) { if (on) n.add(r.id); else n.delete(r.id) } return n })
  const tickUpTo = () => {
    const cents = parseDollars(limit)
    if (cents == null || cents <= 0) { setLimitError('Enter a dollar amount first.'); return }
    setLimitError(null)
    const ok = new Set(selectUpTo(shownOpen, cents))
    setTicked((t) => { const n = new Set([...t].filter((id) => !shownIds.has(id))); for (const id of ok) n.add(id); return n })
  }

  const pickedShort = picked.filter((r) => r.kind === 'short-open')
  const pickedOver = picked.filter((r) => r.kind === 'over-open')
  const sum = (list: DifferenceRow[]) => list.reduce((n, r) => n + r.differenceCents, 0)

  const post = async () => {
    setPosting(true)
    try {
      const res = await acceptDifferences({ items: acceptItems(picked), note: note.trim() || undefined, clientRequestId: crypto.randomUUID().slice(0, 12) })
      const failed = res.results.filter((r) => !r.ok)
      if (res.accepted > 0) toast.success(`${res.accepted} accepted as paid in full`)
      if (failed.length > 0) toast.error(`${failed.length} skipped: ${failed[0].error ?? 'it changed'}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ''}. Refresh and look again.`)
      const done = new Set(res.results.filter((r) => r.ok).map((r) => r.key))
      setTicked((t) => new Set([...t].filter((id) => !done.has(id))))
      setConfirm(false)
      setNote('')
    } catch (e: unknown) {
      toast.error(graphqlErrorText(e) || 'Could not accept the differences')
    } finally {
      setPosting(false)
      onAccepted()
    }
  }

  const columns: Array<DenseColumn<DifferenceRow>> = useMemo(() => [
    { key: 'select', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 44 },
    {
      key: 'kind', header: 'Kind', text: (r) => DIFFERENCE_KIND_LABEL[r.kind], filter: 'multi', optionsOf: (r) => opt(DIFFERENCE_KIND_LABEL[r.kind]),
      fixedOptions: KINDS.map((k) => ({ value: DIFFERENCE_KIND_LABEL[k], label: DIFFERENCE_KIND_LABEL[k] })),
    },
    { key: 'customer', header: 'Customer', text: (r) => r.customerName, filter: 'multi', optionsOf: (r) => opt(r.customerName) },
    { key: 'invoice', header: 'Invoice / PRO', text: (r) => r.invoiceRefs },
    { key: 'date', header: 'Date', text: (r) => (r.date ? formatDay(r.date) : ''), filter: 'date', dateOf: (r) => r.date || null, sortValue: (r) => r.date },
    { key: 'type', header: 'Type', text: (r) => (r.factored ? 'Factored (OTR)' : 'Manual'), filter: 'multi', optionsOf: (r) => opt(r.factored ? 'Factored (OTR)' : 'Manual') },
    { key: 'method', header: 'Method', text: (r) => r.method, filter: 'multi', optionsOf: (r) => opt(r.method) },
    { key: 'reference', header: 'Reference', text: (r) => r.reference },
    {
      key: 'expected', header: 'Invoice total', align: 'right', text: (r) => (r.expectedCents ? formatCents(r.expectedCents) : ''), sortValue: (r) => r.expectedCents,
      filter: 'number', numberOf: (r) => r.expectedCents / 100, numberUnit: '$',
    },
    {
      key: 'received', header: 'Received', align: 'right', text: (r) => (r.receivedCents ? formatCents(r.receivedCents) : ''), sortValue: (r) => r.receivedCents,
      filter: 'number', numberOf: (r) => r.receivedCents / 100, numberUnit: '$',
    },
    {
      key: 'difference', header: 'Difference', align: 'right', text: (r) => formatCents(r.differenceCents), sortValue: (r) => r.differenceCents,
      filter: 'number', numberOf: (r) => r.differenceCents / 100, numberUnit: '$',
    },
    { key: 'note', header: 'Note', text: (r) => r.note },
  ], [])

  const renderCell = (r: DifferenceRow, key: string): ReactNode => {
    switch (key) {
      case 'select':
        return isOpenKind(r.kind)
          ? <input type="checkbox" aria-label={`Select ${r.invoiceRefs || r.customerName}`} checked={tickedAll.has(r.id)} onChange={() => toggle(r.id)} />
          : null
      case 'kind':
        return <TmsBadge tone={KIND_TONE[r.kind]}>{DIFFERENCE_KIND_LABEL[r.kind]}</TmsBadge>
      case 'invoice':
        return r.invoiceId && !r.invoiceRefs.includes(',') ? <Link to={invoicePath(r.invoiceId)}>{r.invoiceRefs}</Link> : r.invoiceRefs
      case 'difference':
        return <strong>{formatCents(r.differenceCents)}</strong>
      default:
        return undefined
    }
  }

  const customerName = customerId ? customers.get(customerId)?.name ?? '' : ''
  if (all.length === 0) return <p className="tms-muted text-sm" style={{ padding: 16 }} data-testid="differences-empty">{loading ? 'Loading…' : 'No short pays or overpays.'}</p>

  return (
    <div className="pr-out" data-testid="payments-differences">
      <div className="pr-out-summary" data-testid="differences-summary">
        {KINDS.map((k) => (
          <button key={k} type="button" className="pr-toggle" aria-pressed={kindChip === k} data-testid={`chip-${k}`}
            onClick={() => setKindChip((c) => (c === k ? null : k))}>
            {DIFFERENCE_KIND_LABEL[k]} {totals[k].count} · {formatCents(totals[k].cents)}
          </button>
        ))}
        {shownOpen.length > 0 && (
          <>
            <TmsButton size="sm" variant="ghost" onClick={() => tickAll(!allTicked)} data-testid="select-all-open">
              {allTicked ? 'Clear selection' : `Select all open (${shownOpen.length})`}
            </TmsButton>
            <TmsInput inputMode="decimal" aria-label="Select open differences up to" placeholder="Up to $" value={limit}
              onChange={(e) => { setLimit(e.target.value); setLimitError(null) }} />
            <TmsButton size="sm" onClick={tickUpTo} data-testid="select-up-to">Select ≤ amount</TmsButton>
          </>
        )}
        {limitError && <span className="pr-out-errors" role="alert">{limitError}</span>}
      </div>

      <ArDenseTable<DifferenceRow>
        grid={{
          gridId: 'payments-differences',
          label: 'Short pays and overpays',
          columns,
          rows,
          rowKey: (r) => r.id,
          renderCell,
          onFiltered,
          defaultColumns: ['select', 'kind', 'customer', 'invoice', 'date', 'type', 'reference', 'received', 'difference'],
          cardLayout: { title: 'invoice', party: 'customer', amount: 'difference', pills: ['kind'] },
          empty: loading ? 'Loading…' : `No differences match${customerName ? ` for ${customerName}` : ''}.`,
        }}
        pageFilters={{ count: kindChip ? 1 : 0, onClear: () => setKindChip(null) }}
      />

      {picked.length > 0 && (
        <div className="pr-out-bar" data-testid="differences-bar">
          <strong className="pr-out-bar-title">{picked.length} selected · {formatCents(sum(picked))}</strong>
          <TmsInput aria-label="Reason (optional)" placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <TmsButton variant="primary" size="sm" onClick={() => setConfirm(true)} data-testid="accept-differences">Accept as paid in full</TmsButton>
        </div>
      )}

      {confirm && (
        <TmsDialog
          open
          onOpenChange={(o) => { if (!o && !posting) setConfirm(false) }}
          title={`Accept ${picked.length} as paid in full`}
          footer={
            <>
              <TmsButton variant="ghost" disabled={posting} onClick={() => setConfirm(false)}>Back</TmsButton>
              <TmsButton variant="primary" disabled={posting} onClick={() => { void post() }} data-testid="accept-confirm">
                {posting ? 'Accepting…' : 'Accept as paid in full'}
              </TmsButton>
            </>
          }
        >
          <div className="flex flex-col gap-2 text-sm" data-testid="accept-readback">
            {pickedShort.length > 0 && (
              <p><strong>{pickedShort.length}</strong> short pay{pickedShort.length === 1 ? '' : 's'}, <strong>{formatCents(sum(pickedShort))}</strong> written off. Each invoice ends PAID.</p>
            )}
            {pickedOver.length > 0 && (
              <p><strong>{pickedOver.length}</strong> overpay{pickedOver.length === 1 ? '' : 's'}, <strong>{formatCents(sum(pickedOver))}</strong> accepted. Never kept as customer credit.</p>
            )}
            <ul className="flex flex-col gap-1">
              {picked.slice(0, 12).map((r) => (
                <li key={r.id} className="flex justify-between gap-3">
                  <span>{r.customerName} · {r.invoiceRefs || r.reference} <span className="tms-muted">· {DIFFERENCE_KIND_LABEL[r.kind]}</span></span>
                  <strong>{formatCents(r.differenceCents)}</strong>
                </li>
              ))}
            </ul>
            {picked.length > 12 && <p className="tms-muted">…and {picked.length - 12} more.</p>}
            <p className="tms-muted">Each is applied only if its amount is still what you see here; anything that changed is skipped. Every one is audited and can be reversed from Payments Received.</p>
          </div>
        </TmsDialog>
      )}
    </div>
  )
}
