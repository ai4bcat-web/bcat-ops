/**
 * Staff upload of one file onto a shipment: pick it, say what it is and where it
 * belongs, and the three-step flow does the rest.
 *
 * PREPARE signs a PUT pinned to the exact type and length, the browser sends the bytes
 * straight to S3, and COMMIT writes the row only once the object is really there. S3 is
 * read-after-write consistent for a new object but the presigned PUT and the commit are
 * two different requests, so a commit can still arrive before the upload finished
 * landing; that answer is retryable rather than a failure, and this dialog retries it
 * exactly once before showing anything to the user.
 *
 * The size and type checks here are the same ones the Lambda enforces. They exist to
 * say "that is a 40 MB video" before somebody waits for the upload, not instead of the
 * server's check.
 */
import { useRef, useState } from 'react'
import { AlertTriangle, FileUp, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsSelect } from '@/features/tms/kit'
import { Label } from '@/components/ui/label'
import { commitDocument, prepareDocumentUpload, putPresignedFile } from '@/lib/apiClient'
import {
  ACCEPTED_CONTENT_TYPES, DEFAULT_AUDIENCE, DOCUMENT_TYPE_LABELS, MAX_DOCUMENT_BYTES, SHIPMENT_DOCUMENT_TYPES,
} from '@/lib/shipmentDocuments'
import type { ShipmentBundle, ShipmentDocumentAudience, ShipmentDocumentType } from '@/types/tms'

const AUDIENCES: readonly ShipmentDocumentAudience[] = ['CUSTOMER', 'CARRIER', 'ALL', 'INTERNAL']

const AUDIENCE_LABELS: Record<ShipmentDocumentAudience, string> = {
  CUSTOMER: 'Customer — may be e-mailed to the customer',
  CARRIER: 'Carrier — may be e-mailed to the carrier',
  ALL: 'Everyone — either side may receive it',
  INTERNAL: 'Internal — never leaves the building',
}

/** What the file picker offers, derived from what the Lambda will actually sign. */
const ACCEPT = ACCEPTED_CONTENT_TYPES.join(',')

const MAX_MB = Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))

/** Long enough for a PUT that has already returned to be visible to a HEAD. */
const COMMIT_RETRY_MS = 1500

function fileProblem(file: File): string | null {
  if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name} is a ${file.type || 'file of unknown type'}. Documents must be a PDF, a PNG or a JPEG.`
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${MAX_MB} MB.`
  }
  if (file.size === 0) return `${file.name} is empty.`
  return null
}

export function UploadDocumentDialog({ bundle, onClose, onSaved }: {
  bundle: ShipmentBundle
  onClose: () => void
  /** The row landed: the tab re-reads its documents and the order's gate. */
  onSaved: () => void
}) {
  const order = bundle.orders[0] ?? null
  const assignments = bundle.loadCarriers

  const [file, setFile] = useState<File | null>(null)
  const [type, setType] = useState<ShipmentDocumentType>('POD')
  // `ORDER:<id>` · `CARRIER:<id>` · `SHIPMENT` — the three places a row can land.
  const [placement, setPlacement] = useState(order ? `ORDER:${order.id}` : 'SHIPMENT')
  // Null until the user picks one, so changing the type keeps following the type's own
  // default instead of freezing whatever the first type happened to suggest.
  const [audience, setAudience] = useState<ShipmentDocumentAudience | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const effectiveAudience = audience ?? DEFAULT_AUDIENCE[type]

  const take = (picked: File | null | undefined) => {
    if (!picked) return
    const problem = fileProblem(picked)
    setError(problem)
    setFile(problem ? null : picked)
  }

  const upload = async () => {
    if (!file) { setError('Choose a file first.'); return }
    const problem = fileProblem(file)
    if (problem) { setError(problem); return }

    const target = placement.startsWith('CARRIER:')
      ? assignments.find((c) => c.id === placement.slice('CARRIER:'.length)) ?? null
      : null

    setBusy(true)
    setError(null)
    try {
      const prepared = await prepareDocumentUpload({
        shipmentId: bundle.shipment.id,
        type,
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      })
      await putPresignedFile(prepared.uploadUrl, file, file.type)

      const commit = () => commitDocument({
        shipmentId: bundle.shipment.id,
        documentId: prepared.documentId,
        s3Key: prepared.s3Key,
        type,
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        orderId: placement.startsWith('ORDER:') ? placement.slice('ORDER:'.length) : null,
        loadId: target?.loadId ?? null,
        loadCarrierId: target?.id ?? null,
        audience: effectiveAudience,
      })

      try {
        await commit()
      } catch (err) {
        // The one retryable answer: the bytes are on their way but the HEAD that
        // verifies them came back empty. Everything else is the server's final word.
        if (!(err instanceof Error) || !/has not landed/i.test(err.message)) throw err
        // The executor form, not `Promise.withResolvers`: the app compiles against the
        // ES2023 lib, where that method does not exist.
        await new Promise<void>((resolve) => { setTimeout(resolve, COMMIT_RETRY_MS) })
        await commit()
      }

      toast.success(`${DOCUMENT_TYPE_LABELS[type]} uploaded`)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The document could not be uploaded')
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose() }}
      title="Upload a document"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => { void upload() }} disabled={busy || !file}>
            <Upload size={14} className="mr-1" />{busy ? 'Uploading…' : 'Upload'}
          </TmsButton>
        </>
      }
    >
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); take(e.dataTransfer.files?.[0]) }}
          className={`rounded-[var(--tms-radius)] border border-dashed p-4 text-center text-sm ${dragging ? 'border-primary bg-[color:var(--tms-primary)]/5' : 'border-[color:var(--tms-border)]'}`}
        >
          <FileUp size={18} className="mx-auto mb-1 tms-muted" />
          {file ? (
            <p className="font-medium">{file.name} <span className="font-normal tms-muted">· {(file.size / 1024).toFixed(0)} KB</span></p>
          ) : (
            <p className="tms-muted">Drop a PDF, PNG or JPEG here — up to {MAX_MB} MB</p>
          )}
          <TmsButton type="button" size="sm" className="mt-2" onClick={() => picker.current?.click()} disabled={busy}>
            Choose a file
          </TmsButton>
          <input
            ref={picker}
            type="file"
            accept={ACCEPT}
            aria-label="Document file"
            className="hidden"
            onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ''; take(picked) }}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label className="tms-field-label">Type</Label>
            <TmsSelect
              aria-label="Document type"
              value={type}
              onChange={(e) => setType(e.target.value as ShipmentDocumentType)}
              disabled={busy}
              className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
            >
              {SHIPMENT_DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>
              ))}
            </TmsSelect>
          </div>

          <div>
            <Label className="tms-field-label">Section</Label>
            <TmsSelect
              aria-label="Document section"
              value={placement}
              onChange={(e) => setPlacement(e.target.value)}
              disabled={busy}
              className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
            >
              {order && <option value={`ORDER:${order.id}`}>Customer order</option>}
              {assignments.map((c) => (
                <option key={c.id} value={`CARRIER:${c.id}`}>
                  {c.kind === 'OWN_ASSET' ? c.driverName ?? 'Own asset' : c.carrierName ?? 'Carrier'}
                  {c.status === 'ACTIVE' ? '' : ` (${c.status.toLowerCase()})`}
                </option>
              ))}
              <option value="SHIPMENT">Shipment</option>
            </TmsSelect>
          </div>

          <div className="sm:col-span-2">
            <Label className="tms-field-label">Who may receive it</Label>
            <TmsSelect
              aria-label="Document audience"
              value={effectiveAudience}
              onChange={(e) => setAudience(e.target.value as ShipmentDocumentAudience)}
              disabled={busy}
              className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
            >
              {AUDIENCES.map((a) => (
                <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>
              ))}
            </TmsSelect>
            {audience === null && (
              <p className="mt-1 text-[11px] tms-muted">
                Default for a {DOCUMENT_TYPE_LABELS[type].toLowerCase()}.
              </p>
            )}
          </div>
        </div>

        {error && (
          <p className="flex items-start gap-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-badge-red)]  p-2 text-xs text-[color:var(--tms-badge-red)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}
          </p>
        )}
    </TmsDialog>
  )
}
