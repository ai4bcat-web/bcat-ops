/**
 * The invoice exactly as the customer opens it (Ryne, 2026-11-12): ONE PDF — the invoice page(s)
 * then every POD — built by PREVIEW_INVOICE_PACKET from the same rule the send uses, plus the
 * files that ride as their own attachments (BOL, the Ivan customer rate con). A POD that will
 * not merge shows here as the reason the send would be refused.
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { TmsBadge } from '@/features/tms/kit'
import { graphqlErrorText, previewInvoicePacket, type InvoicePacketPreview } from '@/lib/apiClient'

function pagesText(n: number): string {
  return `${n} page${n === 1 ? '' : 's'}`
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function InvoicePacketFrame({ invoiceId, pdfKey, excludeDocumentIds, height = 520, onLoaded }: {
  invoiceId: string
  /** The stored invoice PDF; a new key (regenerated) rebuilds the packet. */
  pdfKey: string | null | undefined
  excludeDocumentIds?: readonly string[]
  height?: number
  onLoaded?: (preview: InvoicePacketPreview) => void
}) {
  const excludeKey = (excludeDocumentIds ?? []).join('|')
  const requestKey = `${invoiceId}#${pdfKey ?? ''}#${excludeKey}`
  // The answer is kept with the request it answers, so a stale one never shows for a new invoice.
  const [answer, setAnswer] = useState<{ key: string; preview: InvoicePacketPreview | null; error: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    previewInvoicePacket({ invoiceId, ...(excludeKey ? { excludeDocumentIds: excludeKey.split('|') } : {}) })
      .then((p) => { if (!alive) return; setAnswer({ key: requestKey, preview: p, error: null }); onLoaded?.(p) })
      .catch((err: unknown) => { if (alive) setAnswer({ key: requestKey, preview: null, error: graphqlErrorText(err) || 'Could not build the invoice preview' }) })
    return () => { alive = false }
    // onLoaded is a notification, not an input; requestKey is derived from the other three.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId, pdfKey, excludeKey])

  const current = answer?.key === requestKey ? answer : null
  const preview = current?.preview ?? null
  const error = current?.error ?? null

  if (error) return <p role="alert" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>
  if (!preview) {
    return <p className="flex items-center gap-2 text-sm tms-muted"><Loader2 size={14} className="animate-spin" /> Building the invoice with its POD…</p>
  }
  const podPages = preview.pages.slice(1)
  return (
    <div className="flex flex-col gap-2" data-testid="invoice-packet">
      <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="What the customer receives">
        <strong>{preview.name}</strong>
        {preview.pages.length > 0 && (
          <span className="tms-muted">
            {preview.pages.map((p, i) => `${i === 0 ? 'Invoice' : `POD ${podPages.length > 1 ? i : ''}`.trim()} · ${pagesText(p.pages)}`).join(' + ')}
          </span>
        )}
        {preview.pages.length > 0 && (podPages.length > 0
          ? <TmsBadge tone="green">POD included</TmsBadge>
          : <TmsBadge tone="red">No POD</TmsBadge>)}
      </div>
      {preview.separate.length > 0 && (
        <div className="text-sm">
          <span className="tms-muted">Also attached separately: </span>
          <ul className="inline" aria-label="Separate attachments">
            {preview.separate.map((f, i) => <li key={f.name} className="inline">{i > 0 ? ', ' : ''}{f.name} <span className="tms-muted">({sizeText(f.sizeBytes)})</span></li>)}
          </ul>
        </div>
      )}
      {preview.error && <p role="alert" style={{ color: 'var(--tms-badge-red)' }}>{preview.error}</p>}
      {preview.url && (
        <iframe title={`${preview.name} preview`} src={preview.url} style={{ width: '100%', height, border: '1px solid var(--tms-border)' }} />
      )}
    </div>
  )
}
