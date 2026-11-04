/**
 * Step AM — "Mark signed": the carrier signed outside our signing link (e-mail, fax, in person), so the
 * rep uploads the signed PDF and the ladder moves to "Rate con signed". The PDF is the evidence, so the
 * button stays off until one is chosen. Same three-step upload as every shipment document: PREPARE signs
 * a PUT, the browser sends the bytes to S3, COMMIT writes the row once the object is really there (one
 * retry for the "has not landed" answer).
 */
import { useRef, useState } from 'react'
import { FileUp } from 'lucide-react'
import { TmsAlert, TmsButton, TmsDialog } from '@/features/tms/kit'
import { commitDocument, prepareDocumentUpload, putPresignedFile } from '@/lib/apiClient'
import { MAX_DOCUMENT_BYTES } from '@/lib/shipmentDocuments'

const COMMIT_RETRY_MS = 1500
const MAX_MB = Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))

function signedPdfProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.type !== 'application/pdf') return `${file.name} is not a PDF. Upload the signed rate confirmation as a PDF.`
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > MAX_DOCUMENT_BYTES) return `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${MAX_MB} MB.`
  return null
}

export function MarkSignedDialog({ shipmentId, loadId, loadCarrierId, carrierName, busy, onClose, onConfirm }: {
  shipmentId: string
  loadId?: string | null
  loadCarrierId: string
  carrierName?: string | null
  busy: boolean
  onClose: () => void
  /** Called with the committed RATE_CON document's id; rejects with the server's sentence. */
  onConfirm: (documentId: string) => Promise<void>
}) {
  const [file, setFile] = useState<File | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const disabled = busy || working

  const take = (picked: File | null | undefined) => {
    if (!picked) return
    const problem = signedPdfProblem(picked)
    setError(problem)
    setFile(problem ? null : picked)
  }

  const submit = async () => {
    if (!file) { setError('Choose the signed PDF first.'); return }
    setWorking(true)
    setError(null)
    try {
      const prepared = await prepareDocumentUpload({
        shipmentId, type: 'RATE_CON', name: file.name, contentType: file.type, sizeBytes: file.size,
      })
      await putPresignedFile(prepared.uploadUrl, file, file.type)
      const commit = () => commitDocument({
        shipmentId,
        documentId: prepared.documentId,
        s3Key: prepared.s3Key,
        type: 'RATE_CON',
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        loadId: loadId ?? null,
        loadCarrierId,
      })
      try {
        await commit()
      } catch (err) {
        if (!(err instanceof Error) || !/has not landed/i.test(err.message)) throw err
        await new Promise<void>((resolve) => { setTimeout(resolve, COMMIT_RETRY_MS) })
        await commit()
      }
      await onConfirm(prepared.documentId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The signed rate confirmation could not be saved.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !disabled) onClose() }}
      title="Mark rate con signed"
      description={`${carrierName ? `${carrierName} signed outside the signing link. ` : ''}Upload the signed PDF as the record.`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={disabled}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="mark-signed-confirm" onClick={() => { void submit() }} disabled={disabled || !file}>
            {working ? 'Uploading…' : 'Upload and mark signed'}
          </TmsButton>
        </>
      }
    >
      <div
        className="rounded-[var(--tms-radius)] border border-dashed border-[color:var(--tms-border)] p-4 text-center text-sm"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); take(e.dataTransfer.files?.[0]) }}
      >
        <FileUp size={18} className="mx-auto mb-1 tms-muted" />
        {file
          ? <p className="font-medium">{file.name} <span className="font-normal tms-muted">· {(file.size / 1024).toFixed(0)} KB</span></p>
          : <p className="tms-muted">Drop the signed PDF here, up to {MAX_MB} MB</p>}
        <TmsButton type="button" size="sm" className="mt-2" onClick={() => picker.current?.click()} disabled={disabled}>
          Choose a PDF
        </TmsButton>
        <input
          ref={picker}
          type="file"
          accept="application/pdf"
          aria-label="Signed rate confirmation PDF"
          className="hidden"
          onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ''; take(picked) }}
        />
      </div>
      {error && <div className="mt-3"><TmsAlert tone="red" role="alert"><span data-testid="mark-signed-error">{error}</span></TmsAlert></div>}
    </TmsDialog>
  )
}
