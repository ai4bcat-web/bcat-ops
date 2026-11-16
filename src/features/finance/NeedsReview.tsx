/**
 * Needs review (Ryne 2026-11-13): shipments AR/AP should check before trusting their numbers, each
 * with the reason it was flagged. The same list sits on the Invoicing (AR) and Payables (AP) pages;
 * the carrier note (`financeReviewApNote`, carrier pay) is shown on the AP page only.
 *
 * Since 2026-11-16 it is also where the open questions live ("remove the open questions tab and move
 * everything into the needs review tab ... so it's all there in one place"): one list, a flagged
 * shipment or a question per row, open first and oldest first. A question opens its card (answer,
 * resolve, reopen) in a dialog. Cleared shipment flags leave the list; resolved questions stay under
 * Resolved.
 */
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsInput, TmsSegmentedTabs, TmsTable, type ColumnDef } from '@/features/tms/kit'
import { QuestionCard } from '@/features/openQuestions/QuestionCard'
import {
  AREA_LABEL, ageDays, questionOnSide, whoFromEmail, type OpenQuestion, type OpenQuestionFilter,
} from '@/features/openQuestions/openQuestions'
import { reviewItems, type ReviewItem } from './needsReviewItems'
import { useAuthUser } from '@/hooks/useAuth'
import { financeAction, setDeliveredDate, type FinanceReviewShipment } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'
import { formatDateShort } from '@/lib/date'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import type { InvoiceRecord } from '@/types/tms'

interface Props {
  rows: FinanceReviewShipment[]
  error: string | null
  /** AP page: also show the carrier note (carrier pay is internal to AP). */
  side: 'AR' | 'AP'
  onCleared: () => void
  /**
   * AR page (Ryne 2026-11-14): the PRO opens that shipment's invoice when it has one, like every other AR tab.
   * A flagged load with no invoice yet keeps the link to the shipment, where the fix is made.
   */
  invoiceFor?: (shipmentId: string) => InvoiceRecord | undefined
  onOpenInvoice?: (invoice: InvoiceRecord) => void
  /** Open questions (all of them; this list keeps the ones for its side). Empty for people who may not see them. */
  questions?: OpenQuestion[]
  onQuestionSaved?: (next: OpenQuestion) => void
}

export function NeedsReviewList({ rows, error, side, onCleared, invoiceFor, onOpenInvoice, questions = [], onQuestionSaved }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<OpenQuestionFilter>('OPEN')
  const [answering, setAnswering] = useState<string | null>(null)
  const who = whoFromEmail(useAuthUser()?.email)
  const mine = useMemo(() => questions.filter((it) => questionOnSide(it, side)), [questions, side])
  const shown = useMemo(() => reviewItems(rows, mine, side, status, search), [rows, mine, side, status, search])
  const openCount = rows.length + mine.filter((it) => it.status === 'OPEN').length
  const resolvedCount = mine.filter((it) => it.status === 'RESOLVED').length
  const answeringItem = answering ? mine.find((it) => it.id === answering) ?? null : null
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
  const flagPro = (row: FinanceReviewShipment) => {
    const invoice = invoiceFor?.(row.id)
    return invoice && onOpenInvoice
      ? <button type="button" className="tms-link" aria-label={`Open invoice for PRO ${row.number ?? row.id}`} onClick={() => onOpenInvoice(invoice)}>{row.number ?? row.id}</button>
      : <Link to={shipmentEditorPath(row.id)}>{row.number ?? row.id}</Link>
  }
  const questionPros = (q: OpenQuestion) => {
    if (!q.details.refs.length) return '—'
    return (
      <span className="flex flex-wrap gap-x-2">
        {q.details.refs.map((r, i) => (r.shipmentId
          ? <Link key={`${r.pro}-${i}`} to={shipmentEditorPath(r.shipmentId)}>{r.pro}</Link>
          : <span key={`${r.pro}-${i}`}>{r.pro}</span>))}
      </span>
    )
  }
  const parties = (q: OpenQuestion) => [...new Set(q.details.refs.map((r) => r.party).filter(Boolean))].join(', ')
  const age = (it: ReviewItem) => {
    const d = ageDays(it.at)
    return d == null ? '—' : d === 0 ? 'Today' : `${d} d`
  }
  const columns: ColumnDef<ReviewItem>[] = [
    {
      key: 'type', header: 'Type',
      render: (it) => (it.kind === 'flag'
        ? <TmsBadge tone="orange">Shipment flag</TmsBadge>
        : <TmsBadge tone="blue">{`Question · ${AREA_LABEL[it.question.details.area]}`}</TmsBadge>),
      text: (it) => (it.kind === 'flag' ? 'Shipment flag' : 'Question'),
    },
    {
      key: 'pro', header: 'PRO',
      render: (it) => (it.kind === 'flag' ? flagPro(it.row) : questionPros(it.question)),
      text: (it) => (it.kind === 'flag' ? String(it.row.number ?? '') : it.question.details.refs.map((r) => r.pro).join(' ')),
    },
    {
      key: 'customer', header: 'Customer / carrier',
      render: (it) => (it.kind === 'flag' ? it.row.customerName ?? '—' : parties(it.question) || '—'),
      text: (it) => (it.kind === 'flag' ? it.row.customerName ?? '' : parties(it.question)),
    },
    {
      key: 'reason', header: 'Reason / question',
      render: (it) => (it.kind === 'flag' ? it.row.financeReviewReason ?? '—' : <span style={{ whiteSpace: 'normal' }}>{it.question.question}</span>),
      text: (it) => (it.kind === 'flag' ? it.row.financeReviewReason ?? '' : it.question.question),
    },
    {
      key: 'context', header: side === 'AP' ? 'Carrier note / details' : 'Details',
      render: (it) => {
        if (it.kind === 'flag') return side === 'AP' ? it.row.financeReviewApNote ?? '—' : '—'
        const d = it.question.details
        const parts = [d.aljex ? `Aljex: ${d.aljex}` : '', d.bcat ? `BCAT Ops: ${d.bcat}` : ''].filter(Boolean)
        return parts.length ? <span style={{ whiteSpace: 'normal' }}>{parts.join(' · ')}</span> : (d.context ?? '—')
      },
      text: (it) => (it.kind === 'flag' ? (side === 'AP' ? it.row.financeReviewApNote ?? '' : '') : [it.question.details.aljex, it.question.details.bcat].filter(Boolean).join(' ')),
    },
    { key: 'delivered', header: 'Delivered', render: (it) => (it.kind === 'flag' ? deliveredCell(it.row) : '—'), text: (it) => (it.kind === 'flag' ? it.row.deliveredAt ?? '' : '') },
    {
      key: 'status', header: 'Status',
      render: (it) => (it.kind === 'question' && it.question.status === 'RESOLVED'
        ? <TmsBadge tone="green">Resolved</TmsBadge>
        : <TmsBadge tone="orange">Open</TmsBadge>),
      text: (it) => (it.kind === 'question' && it.question.status === 'RESOLVED' ? 'Resolved' : 'Open'),
    },
    { key: 'age', header: 'Age', render: age, text: (it) => it.at },
    {
      key: 'actions', header: '',
      render: (it) => (it.kind === 'flag'
        ? <TmsButton size="sm" variant="ghost" disabled={busy === it.row.id} onClick={() => clear(it.row)}>Mark reviewed</TmsButton>
        : <TmsButton size="sm" variant={it.question.status === 'OPEN' ? 'primary' : 'ghost'} onClick={() => setAnswering(it.question.id)}>
          {it.question.status === 'OPEN' ? 'Answer' : 'View'}
        </TmsButton>),
    },
  ]
  return (
    <div data-testid={`needs-review-${side.toLowerCase()}`}>
      {error && <p style={{ color: 'var(--tms-badge-red)' }} className="text-sm">{error}</p>}
      <div className="tms-dense-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <TmsSegmentedTabs
          aria-label="Needs review status"
          size="sm"
          active={status}
          onSelect={(k) => setStatus(k as OpenQuestionFilter)}
          tabs={[
            { key: 'OPEN', label: 'Open', count: openCount },
            { key: 'RESOLVED', label: 'Resolved', count: resolvedCount },
            { key: 'ALL', label: 'All', count: openCount + resolvedCount },
          ]}
        />
        <Search size={14} className="tms-muted" aria-hidden="true" />
        <TmsInput className="tms-dense-search" aria-label="Search" data-testid={`needs-review-search-${side.toLowerCase()}`}
          placeholder={side === 'AP' ? 'Search PRO, customer, carrier note, question…' : 'Search PRO, customer, reason, question…'}
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="tms-muted">{`${shown.length} row${shown.length === 1 ? '' : 's'}`}</span>
      </div>
      <TmsTable columns={columns} rows={shown} rowKey={(it) => it.key} empty={status === 'RESOLVED' ? 'Nothing resolved yet.' : 'Nothing needs review.'} />
      <TmsDialog
        open={answeringItem != null}
        onOpenChange={(open) => { if (!open) setAnswering(null) }}
        title={answeringItem?.status === 'RESOLVED' ? 'Resolved question' : 'Open question'}
      >
        {answeringItem && (
          <QuestionCard item={answeringItem} who={who} onSaved={(next) => { onQuestionSaved?.(next); if (next.status === 'RESOLVED') setAnswering(null) }} />
        )}
      </TmsDialog>
    </div>
  )
}

const chicagoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
/** The delivered day as the date input wants it, read in Chicago like the backend. */
function chicagoDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : chicagoFmt.format(d)
}
