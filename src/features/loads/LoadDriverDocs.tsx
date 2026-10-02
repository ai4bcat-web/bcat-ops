/**
 * Paperwork a driver sent from their phone, shown on the load it belongs to.
 *
 * The drawer used to read only the rate confirmation on the Load row and the PODs JobsDone
 * had linked. A driver could scan a POD at a dock, watch it reach Slack, see it in their
 * own app — and the office would still see an empty slot and chase them for it. This is
 * that missing half, for both document kinds.
 *
 * Read-only on purpose. Staff already have upload controls beside this; what was missing
 * was sight of what had already arrived.
 */
import { FileText, Loader2, ExternalLink, AlertTriangle } from 'lucide-react'
import { useLoadDriverDocs, type LoadDriverDoc } from '@/hooks/useLoadDriverDocs'

const SOURCE_LABEL: Record<string, string> = {
  PWA: 'from the driver app',
  EMAIL: 'forwarded by email',
  STAFF: 'uploaded by staff',
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function DocRow({ doc }: { doc: LoadDriverDoc }) {
  const label = doc.fileName?.trim() || `${doc.kind} page ${doc.pageNumber ?? 1}`
  const who = SOURCE_LABEL[doc.source ?? 'PWA'] ?? 'from the driver app'
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-2">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-foreground">{label}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {doc.driverName} · {who} · {when(doc.uploadedAt)}
        </p>
      </div>
      {doc.url ? (
        <a
          href={doc.url}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
        >
          Open <ExternalLink className="size-3" />
        </a>
      ) : (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
    </li>
  )
}

export function LoadDriverDocs({
  loadId, proNumber, kind,
}: {
  loadId: string | null | undefined
  proNumber: string | null | undefined
  kind: 'POD' | 'RATECON'
}) {
  const { pods, ratecons, loading, error } = useLoadDriverDocs(loadId, proNumber)
  const docs = kind === 'POD' ? pods : ratecons

  if (error) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-amber-700">
        <AlertTriangle className="size-3" /> {error}
      </p>
    )
  }

  // Nothing sent is the normal case and needs no words; the upload control is right there.
  if (loading || docs.length === 0) return null

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <FileText className="size-3" />
        {kind === 'POD' ? 'Sent by the driver' : 'Rate con sent by the driver'}
        <span className="font-normal normal-case tracking-normal">({docs.length})</span>
      </p>
      <ul className="space-y-1.5">
        {docs.map((doc) => <DocRow key={doc.id} doc={doc} />)}
      </ul>
    </div>
  )
}
