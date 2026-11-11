import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, Eye, Upload } from 'lucide-react'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { DocumentPreviewModal } from '@/features/files/DocumentPreviewModal'
import { ACCEPTED_DOC_EXT } from '@/lib/complianceClient'
import { downloadFromUrl } from '@/lib/download'
import type { FileSlot, SlotState } from '@/lib/fileHub'
import type { FileHubState } from '@/hooks/useFileHub'
import type { ComplianceDocument, ComplianceEntityType } from '@/types'
import './profiles.css'

const STATE_LABEL: Record<SlotState, { label: string; tone: 'green' | 'orange' | 'red' | 'gray' }> = {
  VALID: { label: 'On file', tone: 'green' },
  EXPIRING_SOON: { label: 'Expiring soon', tone: 'orange' },
  EXPIRED: { label: 'Expired', tone: 'red' },
  MISSING: { label: 'Missing', tone: 'gray' },
  WAIVED: { label: 'Not required', tone: 'gray' },
  PENDING_REVIEW: { label: 'To review', tone: 'orange' },
}

/**
 * The required documents of ONE driver or asset: status, expiry, view, download, upload and "not
 * required". It reads and writes the shared compliance document store through the Files hub, so
 * a file uploaded here shows in the Files page and the other way round. Drivers and trucks share
 * this panel; the caller supplies the slots and how a slot's state is worked out.
 */
export function ProfileDocuments({
  entityType, entityId, slots, hub, stateOf, uploadedBy, needsExpiration, expiryDefault, onUploaded,
}: {
  entityType: ComplianceEntityType
  entityId: string
  slots: readonly FileSlot[]
  hub: FileHubState
  stateOf: (slotKey: string) => SlotState
  uploadedBy?: string | null
  /** A dated slot asks for its expiry at upload. Defaults to the slot's own `expires`. */
  needsExpiration?: (slot: FileSlot) => boolean
  /** The date to offer when replacing (the record's copy of the date). */
  expiryDefault?: (slot: FileSlot) => string | null | undefined
  /** After the file is stored: write the date back to the record the rest of the app reads. */
  onUploaded?: (slot: FileSlot, expiration: string | null) => Promise<void>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const target = useRef<FileSlot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<{ slot: FileSlot; file: File; expiration: string } | null>(null)
  const [preview, setPreview] = useState<ComplianceDocument | null>(null)

  const dated = (slot: FileSlot) => (needsExpiration ? needsExpiration(slot) : slot.expires)

  const upload = async (slot: FileSlot, file: File, expiration: string | null) => {
    setBusy(slot.key)
    try {
      await hub.upload({ entityType, entityId, documentType: slot.key, title: slot.label, file, expirationDate: expiration, uploadedByUser: uploadedBy ?? null })
      if (onUploaded) {
        try { await onUploaded(slot, expiration) } catch (err) {
          toast.warning(`${slot.label} uploaded, but its date could not be saved on the record: ${err instanceof Error ? err.message : 'unknown error'}`)
          return
        }
      }
      toast.success(`${slot.label} uploaded`)
    } catch (err) {
      toast.error(`Couldn't upload ${slot.label}: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setBusy(null)
      setPending(null)
    }
  }

  const onChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const slot = target.current
    e.target.value = ''
    target.current = null
    if (!file || !slot) return
    if (dated(slot)) {
      const current = hub.docFor(entityType, entityId, slot.key)?.expirationDate ?? expiryDefault?.(slot) ?? ''
      setPending({ slot, file, expiration: current.slice(0, 10) })
      return
    }
    void upload(slot, file, null)
  }

  const download = async (doc: ComplianceDocument) => {
    if (!doc.s3Key) return
    try {
      await downloadFromUrl(await hub.urlFor(doc.s3Key), doc.s3Key.split('/').pop() ?? doc.title)
    } catch (err) {
      toast.error(`Couldn't download ${doc.title}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const waive = async (slot: FileSlot, doc: ComplianceDocument | undefined) => {
    try {
      await hub.setWaived(entityType, entityId, slot.key, slot.label, doc, doc?.status !== 'WAIVED')
    } catch (err) {
      toast.error(`Couldn't update ${slot.label}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  if (slots.length === 0) return <div className="pf-empty">No documents are required for this type.</div>

  return (
    <>
      <input ref={fileRef} type="file" accept={ACCEPTED_DOC_EXT} hidden data-testid="pf-doc-file" onChange={onChosen} />
      <div className="pf-rows" data-testid="pf-documents">
        {slots.map((slot) => {
          const doc = hub.docFor(entityType, entityId, slot.key)
          const state = stateOf(slot.key)
          const meta = STATE_LABEL[state]
          return (
            <div className="pf-row" key={slot.key} data-testid={`pf-doc-${slot.key}`}>
              <div className="pf-row-main">
                <div className="pf-row-title">{slot.label}{slot.required ? '' : ' (optional)'}</div>
                <div className="pf-row-sub">{slot.sub}{doc?.expirationDate ? ` · expires ${doc.expirationDate.slice(0, 10)}` : ''}</div>
              </div>
              <TmsBadge tone={meta.tone}>{meta.label}</TmsBadge>
              <div className="pf-row-actions">
                {doc?.s3Key ? (
                  <>
                    <TmsButton size="sm" aria-label={`Preview ${slot.label}`} onClick={() => setPreview(doc)}><Eye size={14} /></TmsButton>
                    <TmsButton size="sm" aria-label={`Download ${slot.label}`} onClick={() => void download(doc)}><Download size={14} /></TmsButton>
                  </>
                ) : null}
                <TmsButton size="sm" disabled={busy === slot.key} onClick={() => { target.current = slot; fileRef.current?.click() }}>
                  <Upload size={14} /> {doc?.s3Key ? 'Replace' : 'Upload'}
                </TmsButton>
                {!slot.required ? null : (
                  <TmsButton size="sm" variant="ghost" onClick={() => void waive(slot, doc)}>{doc?.status === 'WAIVED' ? 'Require' : 'Not required'}</TmsButton>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {pending ? (
        <TmsDialog
          open
          onOpenChange={(o) => { if (!o) setPending(null) }}
          title={`${pending.slot.label}: expiry date`}
          description="Shown in the file and used for expiry alerts."
          footer={(
            <>
              <TmsButton variant="ghost" onClick={() => setPending(null)}>Cancel</TmsButton>
              <TmsButton variant="primary" onClick={() => void upload(pending.slot, pending.file, pending.expiration || null)}>Upload</TmsButton>
            </>
          )}
        >
          <TmsField label="Expires on">
            <TmsInput type="date" value={pending.expiration} onChange={(e) => setPending({ ...pending, expiration: e.target.value })} />
          </TmsField>
        </TmsDialog>
      ) : null}
      {preview ? <DocumentPreviewModal doc={preview} getUrl={hub.urlFor} onClose={() => setPreview(null)} /> : null}
    </>
  )
}
