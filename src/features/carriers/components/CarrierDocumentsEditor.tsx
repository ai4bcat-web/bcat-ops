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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
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
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {requiredDocs.map((required) => {
          const matching = documents.filter((d) => d.type === required)
          const expired = matching.length > 0 && matching.every((d) => {
            const expires = d.expiresAt ? Date.parse(d.expiresAt) : NaN
            return Number.isFinite(expires) && expires < nowMs
          })
          const style = matching.length === 0
            ? 'bg-red-100 text-red-700'
            : expired ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
          const suffix = matching.length === 0 ? 'missing' : expired ? 'expired' : 'on file'
          return (
            <Badge key={required} variant="secondary" className={cn('text-[10px]', style)}>
              {DOCUMENT_TYPE_LABELS[required as CarrierDocumentType] ?? required} · {suffix}
            </Badge>
          )
        })}
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="grid grid-cols-4 items-end gap-3">
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Type</Label>
            <select
              aria-label="Document type"
              value={type}
              onChange={(e) => setType(e.target.value as CarrierDocumentType)}
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Expires</Label>
            <Input
              aria-label="Document expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">File</Label>
            <input
              ref={fileRef}
              type="file"
              aria-label="Document file"
              accept="application/pdf,image/png,image/jpeg"
              className="mt-1 block w-full text-xs"
            />
          </div>
          <Button size="sm" onClick={upload} disabled={busy}>
            <Upload size={14} className="mr-1" /> {busy ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>

      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">Expires</th>
              <th className="px-2 py-2">Uploaded</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => {
              const expires = document.expiresAt ? Date.parse(document.expiresAt) : NaN
              const isExpired = Number.isFinite(expires) && expires < nowMs
              return (
                <tr key={document.id} className="border-b border-border/60">
                  <td className="px-2 py-2">{DOCUMENT_TYPE_LABELS[document.type] ?? document.type}</td>
                  <td className="px-2 py-2">
                    {document.name}
                    {document.source !== 'UPLOAD' && (
                      <Badge variant="outline" className="ml-2 text-[10px]">{document.source.toLowerCase()}</Badge>
                    )}
                  </td>
                  <td className={cn('px-2 py-2', isExpired && 'text-destructive')}>
                    {document.expiresAt ? new Date(document.expiresAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {document.uploadedBy} · {new Date(document.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`Open ${document.name}`}
                      onClick={() => void onOpen(document)}
                    >
                      <Download size={14} />
                    </Button>
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`Delete ${document.name}`}
                        onClick={() => void onDelete(document)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
