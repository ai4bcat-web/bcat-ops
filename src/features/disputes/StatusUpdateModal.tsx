/**
 * Work a dispute from the dashboard row: set the status, record what Amazon said, and
 * attach Amazon's reply screenshot — one save, one write.
 *
 * Before this, a status change was the only thing the row could do, so the reply itself
 * lived in someone's inbox and "REJECTED" carried no reason. The driver's own uploads are
 * shown here read-only (staff have no write grant on dispute-proofs/) and are carried
 * through every save untouched; see disputeEvidence.ts.
 */
import { useEffect, useRef, useState } from 'react'
import { ImageUp, Paperclip, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { uploadDisputeResponseImage, deleteDisputeResponseImage } from '@/lib/apiClient'
import { errorMessage } from '@/lib/utils/errorMessage'
import { btnGhost, btnPrimary, Field, FormSection, inputStyle, Modal } from '@/features/maintenance/maintenanceUi'
import type { AmazonDispute, DisputeEvidence, DisputeStatus } from '@/types/dispute'
import { EvidenceGallery } from './EvidenceGallery'
import {
  mergeDisputeEvidence, portalDriverEvidence, responseEvidence, responseFileRejection,
} from './disputeEvidence'

export type DisputePatch = Partial<Omit<AmazonDispute, 'id' | 'createdAt' | 'updatedAt'>>

/** Where a recovered dispute should land on a driver's check, or null for "don't add". */
export interface SettlementChoice {
  periodStart: string
  driverId: string
}

export interface SettlementPicker {
  /** Sunday weeks staff can post the recovery to, newest first. */
  weeks: { value: string; label: string }[]
  /** Pay accounts the credit can be written to. */
  drivers: { id: string; name: string }[]
  /** Pre-selected week + driver: an existing posting, else the name match on this week. */
  initial: { periodStart: string | null; driverId: string | null }
  /** True once this dispute already carries a credit, so the copy says "move" not "add". */
  posted: boolean
}

interface PendingFile {
  file: File
  previewUrl: string
}

export function StatusUpdateModal({
  dispute, initialStatus, statusOptions, statusLabel, actorEmail, settlement, onSave, onClose,
}: {
  dispute: AmazonDispute
  initialStatus: DisputeStatus
  statusOptions: DisputeStatus[]
  statusLabel: Record<DisputeStatus, string>
  actorEmail?: string | null
  settlement?: SettlementPicker
  onSave: (patch: DisputePatch, settlement: SettlementChoice | null) => Promise<void>
  onClose: () => void
}) {
  const [status, setStatus] = useState<DisputeStatus>(initialStatus)
  const [response, setResponse] = useState(dispute.amazonResponse ?? '')
  const [resolvedAmount, setResolvedAmount] = useState(
    dispute.resolvedAmount != null ? String(dispute.resolvedAmount) : '',
  )
  // '' = don't put this recovery on a check. Pre-selected from an existing posting.
  const [settlementWeek, setSettlementWeek] = useState(settlement?.initial.periodStart ?? '')
  const [settlementDriverId, setSettlementDriverId] = useState(settlement?.initial.driverId ?? '')
  // Not a snapshot: the row is re-bound to the live copy on every 30 s poll, so a reply
  // another dispatcher attached while this sheet is open must survive this save too.
  // Removal intent is the only thing that belongs in state.
  const [removedKeys, setRemovedKeys] = useState<string[]>([])
  const [pending, setPending] = useState<PendingFile[]>([])
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const driverFiles = portalDriverEvidence(dispute.evidence)
  const savedResponses = responseEvidence(dispute.evidence).filter((e) => !removedKeys.includes(e.s3Key))
  const originalResponse = dispute.amazonResponse ?? ''

  // Keys of files already in S3 from an earlier save attempt, so a retry after a failed
  // write reuses them instead of uploading the same bytes under a fresh key.
  const uploadedKeys = useRef(new Map<File, string>())

  // Every preview URL ever handed to the browser, so unmount can release them all.
  const previewUrls = useRef<string[]>([])

  const attach = (files: FileList | File[] | null | undefined) => {
    const picked = Array.from(files ?? [])
    if (picked.length === 0) return
    const accepted: PendingFile[] = []
    for (const file of picked) {
      const rejection = responseFileRejection(file)
      if (rejection) { toast.error(rejection); continue }
      const previewUrl = URL.createObjectURL(file)
      previewUrls.current.push(previewUrl)
      accepted.push({ file, previewUrl })
    }
    if (accepted.length > 0) setPending((p) => [...p, ...accepted])
  }

  // Staff screenshot Amazon's case page and hit ⌘V — catch the paste anywhere in the
  // modal, including while the cursor sits in the response textarea. A rich-text paste
  // (Gmail, a web page) carries its inline images in `files` too, so when the caret is in
  // a text field and the clipboard has text, the text paste wins.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length === 0) return
      const types = Array.from(e.clipboardData?.types ?? [])
      const target = e.target as HTMLElement | null
      const inTextField = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable
      if (inTextField && (types.includes('text/plain') || types.includes('text/html'))) return
      e.preventDefault()
      attach(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  // Release the object URLs the previews hold when the modal goes away.
  useEffect(() => () => { for (const url of previewUrls.current) URL.revokeObjectURL(url) }, [])

  const dropPending = (index: number) => {
    setPending((p) => {
      const target = p[index]
      if (target) URL.revokeObjectURL(target.previewUrl)
      return p.filter((_, i) => i !== index)
    })
  }

  const removeSaved = (item: DisputeEvidence) => setRemovedKeys((k) => [...k, item.s3Key])

  // Chosen week + pay account, or null when this recovery stays off the checks. A
  // non-PAID status always clears the posting: money that wasn't recovered can't ride
  // a settlement.
  const choice: SettlementChoice | null =
    status === 'PAID' && settlementWeek && settlementDriverId
      ? { periodStart: settlementWeek, driverId: settlementDriverId }
      : null

  const save = async () => {
    if (saving) return
    if (status === 'PAID' && settlementWeek && !settlementDriverId) {
      toast.error('Pick the driver whose settlement this recovery goes on')
      return
    }
    if (choice && !(parseFloat(resolvedAmount) > 0)) {
      toast.error('Enter the amount recovered before adding it to a settlement')
      return
    }
    setSaving(true)
    try {
      const uploaded: DisputeEvidence[] = []
      for (const { file } of pending) {
        const s3Key = uploadedKeys.current.get(file) ?? await uploadDisputeResponseImage(dispute.id, file)
        uploadedKeys.current.set(file, s3Key)
        uploaded.push({
          s3Key,
          fileName: file.name || 'amazon-response',
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          kind: 'AMAZON_RESPONSE',
        })
      }

      const text = response.trim()
      const responseChanged = text !== originalResponse.trim() || uploaded.length > 0 || removedKeys.length > 0
      const parsedAmount = parseFloat(resolvedAmount)

      const patch: DisputePatch = {
        status,
        evidence: mergeDisputeEvidence(dispute.evidence, [...savedResponses, ...uploaded]),
        amazonResponse: text || null,
        ...(status === 'PAID' ? { resolvedAmount: Number.isFinite(parsedAmount) ? parsedAmount : null } : {}),
        ...(responseChanged
          ? { amazonResponseAt: new Date().toISOString(), amazonResponseBy: actorEmail ?? null }
          : {}),
      }

      await onSave(patch, choice)

      // Only once the row no longer references them: an orphaned S3 object is harmless,
      // a referenced-but-deleted one is a broken link on the dispute.
      for (const key of removedKeys) {
        void deleteDisputeResponseImage(key).catch(() => { /* best effort */ })
      }
      toast.success(`Saved — ${statusLabel[status]}`)
      onClose()
    } catch (err) {
      toast.error(`Couldn't save the update: ${errorMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Update — ${dispute.driverName}${dispute.tripNumber ? ` · ${dispute.tripNumber}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <span />
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={onClose} disabled={saving} style={btnGhost}>Cancel</button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              style={{ ...btnPrimary, opacity: saving ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer' }}
            >
              {saving ? 'Saving…' : 'Save update'}
            </button>
          </div>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <FormSection title="Status">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Status">
              <select
                aria-label="Status"
                style={inputStyle}
                value={status}
                onChange={(e) => setStatus(e.target.value as DisputeStatus)}
              >
                {statusOptions.map((s) => <option key={s} value={s}>{statusLabel[s]}</option>)}
              </select>
            </Field>
            {status === 'PAID' && (
              <Field label="Amount Recovered ($)">
                <input
                  type="number"
                  step="0.01"
                  aria-label="Amount Recovered ($)"
                  style={inputStyle}
                  value={resolvedAmount}
                  onChange={(e) => setResolvedAmount(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
            )}
          </div>
          {status === 'PAID' && settlement && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
                <Field label="Add to settlement week">
                  <select
                    aria-label="Add to settlement week"
                    style={inputStyle}
                    value={settlementWeek}
                    onChange={(e) => setSettlementWeek(e.target.value)}
                  >
                    <option value="">Don't add to a settlement</option>
                    {settlement.weeks.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </Field>
                {settlementWeek && (
                  <Field label="Driver's pay account">
                    <select
                      aria-label="Driver's pay account"
                      style={inputStyle}
                      value={settlementDriverId}
                      onChange={(e) => setSettlementDriverId(e.target.value)}
                    >
                      <option value="">Select the driver…</option>
                      {settlement.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </Field>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 6 }}>
                {settlementWeek
                  ? `Rides that week's Amazon settlement as a DISPUTE shipment dated to the trip, so it pays at the driver's normal percentage.${settlement.posted ? ' Saving moves the existing row.' : ''}`
                  : settlement.posted
                    ? 'Saving removes the dispute row already on a settlement.'
                    : 'Pick a week to pay this recovery out on that check.'}
              </div>
            </div>
          )}
        </FormSection>

        <FormSection title="Amazon's Response">
          <Field label="What Amazon said">
            <textarea
              rows={4}
              aria-label="What Amazon said"
              style={{ ...inputStyle, resize: 'vertical', minHeight: 92, lineHeight: 1.5 }}
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="Paste Amazon's reply — case number, decision, amount approved…"
            />
          </Field>

          {dispute.amazonResponseAt && (
            <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: -6 }}>
              Last recorded {new Date(dispute.amazonResponseAt).toLocaleString()}
              {dispute.amazonResponseBy ? ` by ${dispute.amazonResponseBy}` : ''}
            </div>
          )}

          <Field label="Amazon Screenshot">
            <div
              tabIndex={0}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); attach(e.dataTransfer.files) }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                minHeight: 74, padding: 12, borderRadius: 9, cursor: 'pointer',
                border: '1px dashed var(--ds-border-strong)', background: 'var(--ds-bg)',
              }}
              onClick={() => fileRef.current?.click()}
            >
              <ImageUp size={18} style={{ color: 'var(--ds-t3)' }} />
              <span style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>
                Paste (⌘V), drop, or <span style={{ color: 'var(--ds-blue)', fontWeight: 600 }}>browse</span> — screenshot or PDF, up to 10 MB
              </span>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,application/pdf"
                data-testid="amazon-response-file"
                style={{ display: 'none' }}
                onChange={(e) => { attach(e.target.files); e.target.value = '' }}
              />
            </div>
          </Field>

          {pending.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {pending.map((p, i) => (
                <div
                  key={`${p.file.name}-${i}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                    borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
                  }}
                >
                  {p.file.type.startsWith('image/')
                    ? <img src={p.previewUrl} alt={p.file.name} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6 }} />
                    : <Paperclip size={16} style={{ color: 'var(--ds-t3)' }} />}
                  <span style={{ fontSize: 12.5, color: 'var(--ds-t1)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.file.name}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${p.file.name}`}
                    onClick={() => dropPending(i)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-red)', display: 'inline-flex', padding: 2 }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {savedResponses.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <EvidenceGallery evidence={savedResponses} onRemove={removeSaved} />
            </div>
          )}
          {removedKeys.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
              {removedKeys.length} attached file{removedKeys.length === 1 ? '' : 's'} will be removed when you save.
            </div>
          )}
        </FormSection>

        {driverFiles.length > 0 && (
          <FormSection title={`Driver Evidence (${driverFiles.length})`}>
            <EvidenceGallery evidence={driverFiles} />
            <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
              Uploaded by the driver — kept exactly as filed when you save.
            </div>
          </FormSection>
        )}
      </div>
    </Modal>
  )
}
