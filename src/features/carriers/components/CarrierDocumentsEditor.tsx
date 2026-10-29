/**
 * The carrier's paperwork — COIs, W-9, the signed carrier agreement, the factor's NOA,
 * and every rate confirmation the system generated for them.
 *
 * The checklist at the top is the booking gate's `MISSING_DOC`/`DOC_EXPIRED` warnings in
 * advance: whatever is red here is what somebody will have to acknowledge at booking.
 * Uploads are a presigned PUT straight to S3, then a commit — the file never passes
 * through AppSync.
 */
import { useRef, useState } from 'react'
import { Download, Trash2, Upload } from 'lucide-react'
import { TmsBadge, TmsButton, TmsField, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { CarrierDocumentRecord, CarrierDocumentType } from '@/types/tms'

const DOCUMENT_TYPES: CarrierDocumentType[] = [
  'AUTHORITY', 'COI_AUTO', 'COI_CARGO', 'COI_GENERAL', 'W9', 'CARRIER_AGREEMENT',
  'FACTOR_NOA', 'CDL', 'RATE_CON', 'OTHER',
]

const DOCUMENT_TYPE_LABELS: Record<CarrierDocumentType, string> = {
  AUTHORITY: 'Authority letter',
  COI_AUTO: 'COI — auto liability',
  COI_CARGO: 'COI — cargo',
  COI_GENERAL: 'COI — general liability',
  W9: 'W-9',
  CARRIER_AGREEMENT: 'Carrier agreement',
  FACTOR_NOA: 'Factor NOA',
  CDL: 'CDL',
  RATE_CON: 'Rate confirmation',
  OTHER: 'Other',
}

/** The Lambda refuses anything else; checking here saves a round trip and explains why. */
const ALLOWED_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg']
const MAX_BYTES = 25 * 1024 * 1024

interface CarrierDocumentsEditorProps {
  documents: CarrierDocumentRecord[]
  requiredDocs: readonly string[]
  now: string
  canDelete: boolean
  onUpload: (file: File, type: CarrierDocumentType, expiresAt: string | null) => Promise<void>
  onDelete: (document: CarrierDocumentRecord) => Promise<void>
  onOpen: (document: CarrierDocumentRecord) => Promise<void>
}

export function CarrierDocumentsEditor({
  documents, requiredDocs, now, canDelete, onUpload, onDelete, onOpen,
}: CarrierDocumentsEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [type, setType] = useState<CarrierDocumentType>('COI_CARGO')
  const [expiresAt, setExpiresAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nowMs = Date.parse(now)

  const upload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) { setError('Choose a file first.'); return }
    if (!ALLOWED_CONTENT_TYPES.includes(file.type)) { setError('Only PDF, PNG and JPEG files are accepted.'); return }
    if (file.size > MAX_BYTES) { setError('That file is over the 25 MB limit.'); return }
    setBusy(true)
    setError(null)
    try {
      await onUpload(file, type, expiresAt ? new Date(`${expiresAt}T00:00:00.000Z`).toISOString() : null)
      if (fileRef.current) fileRef.current.value = ''
      setExpiresAt('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {requiredDocs.map((required) => {
          const matching = documents.filter((d) => d.type === required)
          const expired = matching.length > 0 && matching.every((d) => {
            const expires = d.expiresAt ? Date.parse(d.expiresAt) : NaN
            return Number.isFinite(expires) && expires < nowMs
          })
          const tone = matching.length === 0 ? 'red' : expired ? 'orange' : 'green'
          const suffix = matching.length === 0 ? 'missing' : expired ? 'expired' : 'on file'
          return (
            <TmsBadge key={required} tone={tone}>
              {DOCUMENT_TYPE_LABELS[required as CarrierDocumentType] ?? required} · {suffix}
            </TmsBadge>
          )
        })}
      </div>

      <div className="p-3" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
        <div className="tms-grid tms-grid-4 items-end">
          <TmsField label="Type">
            <TmsSelect
              aria-label="Document type"
              value={type}
              onChange={(e) => setType(e.target.value as CarrierDocumentType)}
            >
              {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>)}
            </TmsSelect>
          </TmsField>
          <TmsField label="Expires">
            <TmsInput
              aria-label="Document expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </TmsField>
          <TmsField label="File">
            <input
              ref={fileRef}
              type="file"
              aria-label="Document file"
              accept="application/pdf,image/png,image/jpeg"
              className="block w-full text-xs"
            />
          </TmsField>
          <TmsButton variant="primary" size="sm" onClick={upload} disabled={busy}>
            <Upload size={14} /> {busy ? 'Uploading…' : 'Upload'}
          </TmsButton>
        </div>
        {error && <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>

      {documents.length === 0 ? (
        <p className="tms-muted">Nothing uploaded yet.</p>
      ) : (
        <div className="tms-table-wrap">
          <table className="tms-table">
            <thead>
              <tr>
                <th scope="col">TYPE</th>
                <th scope="col">NAME</th>
                <th scope="col">EXPIRES</th>
                <th scope="col">UPLOADED</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => {
                const expires = document.expiresAt ? Date.parse(document.expiresAt) : NaN
                const isExpired = Number.isFinite(expires) && expires < nowMs
                return (
                  <tr key={document.id}>
                    <td>{DOCUMENT_TYPE_LABELS[document.type] ?? document.type}</td>
                    <td>
                      {document.name}
                      {document.source !== 'UPLOAD' && (
                        <> <TmsBadge tone="gray">{document.source.toLowerCase()}</TmsBadge></>
                      )}
                    </td>
                    <td style={isExpired ? { color: 'var(--tms-badge-red)' } : undefined}>
                      {document.expiresAt ? new Date(document.expiresAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="text-xs tms-muted">
                      {document.uploadedBy} · {new Date(document.createdAt).toLocaleDateString()}
                    </td>
                    <td>
                      <TmsIconButton aria-label={`Open ${document.name}`} onClick={() => void onOpen(document)}>
                        <Download size={14} />
                      </TmsIconButton>
                      {canDelete && (
                        <TmsIconButton aria-label={`Delete ${document.name}`} onClick={() => void onDelete(document)}>
                          <Trash2 size={14} />
                        </TmsIconButton>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
