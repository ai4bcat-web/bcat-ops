/**
 * Loads pushed to DAT from a quote or a spot request (no shipment yet): the postings a carrier-sales rep
 * should see beside the loads that need cover, with Unpost. The rows are the same `ShipmentPosting` rows a
 * shipment's postings use; only those whose subject is `quote:` / `spot:` are listed here.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { OutcomeBadge } from '@/features/quotes/components/OutcomeBadge'
import { getQuote, graphqlErrorText, listActivePostings, unpostQuoteLoad } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import type { QuoteRecord, ShipmentPostingRecord } from '@/types/tms'

const isQuoteSubject = (p: ShipmentPostingRecord): boolean => p.shipmentId.startsWith('quote:') || p.shipmentId.startsWith('spot:')

/** The posted quote's outcome (Won / Lost / Expired / Pending), so a rep does not keep covering a load whose quote is gone. */
function QuoteOutcome({ quoteId }: { quoteId: string }) {
  const [quote, setQuote] = useState<QuoteRecord | null>(null)
  useEffect(() => {
    let live = true
    getQuote(quoteId).then((q) => { if (live) setQuote(q) }).catch(() => { /* outcome is decoration; the posting stands on its own */ })
    return () => { live = false }
  }, [quoteId])
  return quote ? <OutcomeBadge quote={quote} now={new Date().toISOString()} /> : null
}

export function QuotePostingsCard() {
  const [rows, setRows] = useState<ShipmentPostingRecord[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    listActivePostings()
      .then((all) => { if (live) setRows(all.filter(isQuoteSubject)) })
      .catch(() => { /* the card is a convenience; the page's own reads report failures */ })
    return () => { live = false }
  }, [])

  if (rows.length === 0) return null

  const unpost = (row: ShipmentPostingRecord) => {
    setBusy(true)
    const quote = row.shipmentId.startsWith('quote:')
    const subject = row.shipmentId.slice(quote ? 6 : 5)
    unpostQuoteLoad({ quoteId: quote ? subject : null, spotRequestId: quote ? null : subject, providers: [row.provider] })
      .then(() => { toast.success(`Unposted from ${row.provider}`); setRows((cur) => cur.filter((r) => r.id !== row.id)) })
      .catch((err: unknown) => toast.error(graphqlErrorText(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div data-testid="quote-postings" className="tms-stack">
      <p className="tms-field-label tms-flush">Posted from quotes</p>
      {rows.map((row) => {
        const quote = row.shipmentId.startsWith('quote:')
        const subject = row.shipmentId.slice(quote ? 6 : 5)
        return (
          <p key={row.id} className="tms-flush" data-testid={`quote-posting-${row.id}`}>
            <TmsBadge tone="green">{row.provider} · POSTED</TmsBadge>{' '}
            {row.mode === 'STUB' ? <TmsBadge tone="orange">STUB</TmsBadge> : null}{' '}
            {quote ? <Link to={`/tms/rates/${subject}`}>{subject}</Link> : <Link to="/tms/rates/spot">Spot request</Link>}
            {quote ? <> <QuoteOutcome quoteId={subject} /></> : null}
            {' · '}{row.originCity ?? '—'}, {row.originState ?? ''} → {row.destinationCity ?? '—'}, {row.destinationState ?? ''}
            {row.equipmentType ? ` · ${row.equipmentType}` : ''}
            {row.rateCents != null ? ` · ${formatCents(row.rateCents)}` : ''}
            <span className="tms-muted"> · {row.postedAt ? formatDateTime(row.postedAt) : ''}</span>{' '}
            <TmsButton size="sm" disabled={busy} data-testid={`quote-unpost-${row.id}`} onClick={() => unpost(row)}>Unpost</TmsButton>
          </p>
        )
      })}
    </div>
  )
}
