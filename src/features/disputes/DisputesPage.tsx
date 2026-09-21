import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import {
  Plus, Search, Trash2, Pencil, ExternalLink, FileWarning,
  ChevronLeft, ChevronRight, RefreshCw, Link2, Paperclip, MessageSquare,
} from 'lucide-react'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils/errorMessage'
import { formatPayPeriod } from '@/lib/payPeriod'
import { uuid } from '@/lib/disputePortalClient'
import { fileContentType } from '@/lib/disputeFiles'
import {
  createAmazonTrip, updateAmazonTrip, deleteAmazonTrip,
  uploadDisputeStaffProof, deleteDisputeStaffProof,
} from '@/lib/apiClient'
import { disputeRecoveredAmount, disputeTripInput, matchDisputeDriver } from '@/lib/disputeSettlement'
import { sundayOf, shiftWeek, weekLabel, weekLabelLong } from '@/features/driver-pay/week'
import type { Driver } from '@/types'
import type { AmazonDispute, DisputeEvidence, DisputeSource, DisputeStatus } from '@/types/dispute'
import {
  thBase, tdBase, iconBtnStyle,
  inputStyle, btnGhost, btnPrimary, btnDanger, Field, FormSection, Modal,
  Pill,
} from '@/features/maintenance/maintenanceUi'
import { EvidenceGallery } from './EvidenceGallery'
import { StatusUpdateModal, type DisputePatch, type SettlementChoice } from './StatusUpdateModal'
import {
  portalDriverEvidence, responseEvidence, staffProofEvidence,
  staffConfirmationRejection, staffPhotoRejection,
} from './disputeEvidence'
import { FileDrop } from './FileDrop'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtMoney(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const STATUS_ORDER: DisputeStatus[] = ['PENDING', 'POSTED', 'PAID', 'REJECTED']
const STATUS_LABEL: Record<DisputeStatus, string> = {
  PENDING: 'Pending', POSTED: 'Filed with Amazon', PAID: 'Paid', REJECTED: 'Rejected',
}
const STATUS_STYLE: Record<DisputeStatus, { bg: string; fg: string }> = {
  PENDING:  { bg: 'var(--ds-amber-bg)', fg: 'var(--ds-amber)' },
  POSTED:   { bg: 'var(--ds-blue-bg)',  fg: 'var(--ds-blue-dark)' },
  PAID:     { bg: 'var(--ds-green-bg)', fg: 'var(--ds-green)' },
  REJECTED: { bg: 'var(--ds-red-bg)',   fg: 'var(--ds-red)' },
}

const SOURCE_LABEL: Record<DisputeSource, string> = {
  GOOGLE_FORM: 'Google Form',
  MANUAL: 'Manual',
  DRIVER_PORTAL: 'Driver Portal',
}
const SOURCE_TONE: Record<DisputeSource, 'blue' | 'neutral' | 'violet'> = {
  GOOGLE_FORM: 'neutral',
  MANUAL: 'blue',
  DRIVER_PORTAL: 'violet',
}

const PAGE_SIZE = 50
const POLL_MS = 30_000

function statusOf(d: AmazonDispute): DisputeStatus {
  return (d.status as DisputeStatus) ?? 'PENDING'
}

function sourceOf(d: AmazonDispute): DisputeSource {
  return (d.source as DisputeSource) ?? 'MANUAL'
}

// Pill-styled native select — the whole status chip is a dropdown. Picking a status opens
// the update sheet so the Amazon reply is recorded with the change instead of after it.
function StatusSelect({ status, onChange }: {
  status: DisputeStatus
  onChange: (next: DisputeStatus) => void
}) {
  const c = STATUS_STYLE[status]
  return (
    <select
      value={status}
      aria-label="Change status"
      onChange={(e) => onChange(e.target.value as DisputeStatus)}
      title="Change status"
      style={{
        appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
        padding: '3px 10px', borderRadius: 999, border: 'none', cursor: 'pointer',
        fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', lineHeight: 1.4,
        background: c.bg, color: c.fg, textAlign: 'center',
      }}
    >
      {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
    </select>
  )
}

// ── Dispute modal (create + edit) ────────────────────────────────────────────────

type DisputeData = Omit<AmazonDispute, 'id' | 'createdAt' | 'updatedAt'>

function DisputeModal({ dispute, drivers, onSave, onDelete, onClose }: {
  dispute: AmazonDispute | null
  drivers: Driver[]
  onSave: (data: DisputeData) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}) {
  const isEdit = dispute !== null
  const disputeIdRef = useRef(isEdit ? dispute.id : uuid())
  const [form, setForm] = useState({
    driverName:      dispute?.driverName ?? '',
    tripNumber:      dispute?.tripNumber ?? '',
    shipmentDate:    dispute?.shipmentDate ?? '',
    payPeriod:       dispute?.payPeriod ?? '',
    amountPaid:      dispute?.amountPaid != null ? String(dispute.amountPaid) : '',
    amountRequested: dispute?.amountRequested != null ? String(dispute.amountRequested) : '',
    description:     dispute?.description ?? '',
    photoUrl:        dispute?.photoUrl ?? '',
    status:          statusOf(dispute ?? ({} as AmazonDispute)),
    resolvedAmount:  dispute?.resolvedAmount != null ? String(dispute.resolvedAmount) : '',
    notes:           dispute?.notes ?? '',
  })
  const [confirmation, setConfirmation] = useState<File | null>(null)
  const [photos, setPhotos] = useState<File[]>([])
  const [removedProofKeys, setRemovedProofKeys] = useState<string[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const uploadedKeys = useRef(new Map<File, string>())
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))
  const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : undefined }

  const portalFiles = portalDriverEvidence(dispute?.evidence)
  const existingStaffProofs = staffProofEvidence(dispute?.evidence).filter((e) => !removedProofKeys.includes(e.s3Key))
  const responseFiles = responseEvidence(dispute?.evidence)

  const onConfirmationChange = (file: File | null) => {
    setFileError(null)
    setConfirmation(file)
  }
  const onPhotosChange = (incoming: File[]) => {
    setFileError(null)
    setPhotos((prev) => [...prev, ...incoming].slice(0, 5))
  }
  const removePhoto = (index: number) => setPhotos((prev) => prev.filter((_, i) => i !== index))
  const removeStaffProof = (item: DisputeEvidence) => setRemovedProofKeys((keys) => [...keys, item.s3Key])

  const validateFiles = (): string | null => {
    if (!isEdit && !confirmation) return 'A trip confirmation screenshot or PDF is required.'
    if (confirmation) {
      const err = staffConfirmationRejection(confirmation)
      if (err) return err
    }
    for (const photo of photos) {
      const err = staffPhotoRejection(photo)
      if (err) return err
    }
    return null
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.driverName.trim() || saving) return
    const fileValidation = validateFiles()
    if (fileValidation) {
      setFileError(fileValidation)
      return
    }
    setSaving(true)
    setFileError(null)
    const newProofs: DisputeEvidence[] = []
    try {
      if (confirmation) {
        const key = uploadedKeys.current.get(confirmation) ?? await uploadDisputeStaffProof(disputeIdRef.current, confirmation, 'CONFIRMATION')
        uploadedKeys.current.set(confirmation, key)
        newProofs.push({
          s3Key: key,
          fileName: confirmation.name,
          contentType: fileContentType(confirmation) || 'application/octet-stream',
          size: confirmation.size,
          kind: 'CONFIRMATION',
        })
      }
      for (const photo of photos) {
        const key = uploadedKeys.current.get(photo) ?? await uploadDisputeStaffProof(disputeIdRef.current, photo, 'PHOTO')
        uploadedKeys.current.set(photo, key)
        newProofs.push({
          s3Key: key,
          fileName: photo.name,
          contentType: fileContentType(photo) || 'application/octet-stream',
          size: photo.size,
          kind: 'PHOTO',
        })
      }

      const existingStaffConfirmations = existingStaffProofs.filter((e) => e.kind === 'CONFIRMATION')
      const existingStaffPhotos = existingStaffProofs.filter((e) => e.kind === 'PHOTO')
      const replacedConfirmationKeys = confirmation ? existingStaffConfirmations.map((e) => e.s3Key) : []
      const keptStaffConfirmations = confirmation ? [] : existingStaffConfirmations

      const evidence = [
        ...portalFiles,
        ...responseFiles,
        ...keptStaffConfirmations,
        ...existingStaffPhotos,
        ...newProofs,
      ]

      await onSave({
        driverName:      form.driverName.trim(),
        tripNumber:      form.tripNumber.trim() || undefined,
        shipmentDate:    form.shipmentDate.trim() || undefined,
        payPeriod:       form.payPeriod.trim() || undefined,
        amountPaid:      num(form.amountPaid),
        amountRequested: num(form.amountRequested),
        description:     form.description.trim() || undefined,
        photoUrl:        form.photoUrl.trim() || undefined,
        status:          form.status,
        resolvedAmount:  form.status === 'PAID' ? num(form.resolvedAmount) : undefined,
        notes:           form.notes.trim() || undefined,
        evidence,
        ...(isEdit ? {} : { source: 'MANUAL' as const, submittedAt: new Date().toISOString() }),
      })

      // Only delete from S3 once the row no longer references the keys.
      for (const key of [...removedProofKeys, ...replacedConfirmationKeys]) {
        void deleteDisputeStaffProof(key).catch(() => { /* best effort */ })
      }
      onClose()
    } catch (err) {
      toast.error(`Couldn't save dispute: ${errorMessage(err)}`)
      // Clean up newly uploaded orphan files; keep the chosen File objects so the user can retry.
      for (const proof of newProofs) {
        void deleteDisputeStaffProof(proof.s3Key).catch(() => { /* best effort */ })
        for (const [file, key] of uploadedKeys.current) {
          if (key === proof.s3Key) uploadedKeys.current.delete(file)
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete || deleting) return
    setDeleting(true)
    try {
      await onDelete()
      onClose()
    } catch (err) {
      toast.error(`Couldn't delete dispute: ${errorMessage(err)}`)
    } finally {
      setDeleting(false)
    }
  }

  const source = sourceOf(dispute ?? ({} as AmazonDispute))

  const activeDrivers = useMemo(
    () => drivers
      .filter((d) => d.active !== false && d.type !== 'broker')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  )
  const rosterNames = useMemo(() => new Set(activeDrivers.map((d) => d.name)), [activeDrivers])
  const currentNameInRoster = form.driverName !== '' && rosterNames.has(form.driverName)

  return (
    <Modal
      title={isEdit ? 'Edit Dispute' : 'New Dispute'}
      onClose={onClose}
      footer={
        <>
          {isEdit && onDelete ? (
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={deleting || saving}
              style={{ ...btnDanger, opacity: deleting || saving ? 0.6 : 1, cursor: deleting || saving ? 'not-allowed' : 'pointer' }}
            >
              <Trash2 size={14} /> {deleting ? 'Deleting…' : 'Delete'}
            </button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={onClose} disabled={saving || deleting} style={btnGhost}>Cancel</button>
            <button type="submit" form="dispute-form" disabled={saving || deleting} style={{ ...btnPrimary, opacity: saving || deleting ? 0.6 : 1, cursor: saving || deleting ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Saving…' : (isEdit ? 'Save Changes' : <><Plus size={14} /> Create Dispute</>)}
            </button>
          </div>
        </>
      }
    >
      <form id="dispute-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <FormSection title="Trip">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Driver Name" required>
              <select
                style={inputStyle}
                value={form.driverName}
                onChange={(e) => set('driverName', e.target.value)}
                aria-label="Driver name"
                required
              >
                <option value="" disabled>Select driver</option>
                {form.driverName !== '' && !currentNameInRoster && (
                  <option value={form.driverName}>{form.driverName} (not in roster)</option>
                )}
                {activeDrivers.map((d) => (
                  <option key={d.id} value={d.name}>{d.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Trip Number">
              <input style={inputStyle} value={form.tripNumber} onChange={(e) => set('tripNumber', e.target.value)} placeholder="112MP1BHQ" />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Shipment Date">
              <input type="date" style={inputStyle} value={form.shipmentDate} onChange={(e) => set('shipmentDate', e.target.value)} />
            </Field>
            <Field label="7-Day Period">
              <input style={inputStyle} value={form.payPeriod} onChange={(e) => set('payPeriod', e.target.value)} placeholder="4/19 - 4/25 or Sunday start" />
            </Field>
          </div>
          <Field label="Description">
            <textarea rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: 60, lineHeight: 1.5 }} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What happened" />
          </Field>
          <Field label="Legacy Proof Link (Google Drive)">
            <input style={inputStyle} value={form.photoUrl} onChange={(e) => set('photoUrl', e.target.value)} placeholder="https://drive.google.com/…" />
          </Field>
        </FormSection>

        {fileError && (
          <div
            role="alert"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: 12, borderRadius: 9,
              background: 'var(--ds-red-bg)', color: 'var(--ds-red)',
              fontSize: 13, fontWeight: 500,
            }}
          >
            {fileError}
          </div>
        )}

        {isEdit && portalFiles.length > 0 && (
          <FormSection title={`Driver Evidence (${portalFiles.length})`}>
            <EvidenceGallery evidence={portalFiles} />
            <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 6 }}>
              Uploaded by the driver — kept as filed.
            </div>
          </FormSection>
        )}

        {isEdit && responseFiles.length > 0 && (
          <FormSection title={`Amazon Response (${responseFiles.length})`}>
            <EvidenceGallery evidence={responseFiles} />
          </FormSection>
        )}

        {isEdit && existingStaffProofs.length > 0 && (
          <FormSection title={`Staff Proof (${existingStaffProofs.length})`}>
            <EvidenceGallery evidence={existingStaffProofs} onRemove={removeStaffProof} />
          </FormSection>
        )}

        <FormSection title="Evidence">
          <FileDrop
            id="manual-confirmation"
            label={isEdit ? 'Trip confirmation email' : 'Trip confirmation email *'}
            hint="Required for a new dispute. A screenshot, photo, or PDF of the confirmation email. Any image type works. Max 10 MB."
            accept="image/*,application/pdf"
            files={confirmation ? [confirmation] : []}
            onFiles={(files) => onConfirmationChange(files[0] ?? null)}
            onRemove={() => onConfirmationChange(null)}
            browseLabel={confirmation ? 'Replace file' : 'Browse files'}
          />
          <div style={{ marginTop: 16 }}>
            <FileDrop
              id="manual-photos"
              label="Optional photos"
              hint="Up to 5 images (any type), 10 MB each."
              accept="image/*"
              multiple
              files={photos}
              onFiles={onPhotosChange}
              onRemove={removePhoto}
              disabled={photos.length >= 5}
              browseLabel="Add photos"
            />
          </div>
        </FormSection>

        <FormSection title="Amounts & Status">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Paid by Amazon ($)">
              <input type="number" step="0.01" style={inputStyle} value={form.amountPaid} onChange={(e) => set('amountPaid', e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Amount Requested ($)">
              <input type="number" step="0.01" style={inputStyle} value={form.amountRequested} onChange={(e) => set('amountRequested', e.target.value)} placeholder="0.00" />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Status">
              <select aria-label="Dispute status" style={inputStyle} value={form.status} onChange={(e) => set('status', e.target.value as DisputeStatus)}>
                {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </Field>
            {form.status === 'PAID' && (
              <Field label="Amount Recovered ($)">
                <input type="number" step="0.01" aria-label="Recovered amount ($)" style={inputStyle} value={form.resolvedAmount} onChange={(e) => set('resolvedAmount', e.target.value)} placeholder="0.00" />
              </Field>
            )}
          </div>
          <Field label="Internal Notes">
            <textarea rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: 52, lineHeight: 1.5 }} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Notes for the team" />
          </Field>
        </FormSection>

        {isEdit && (
          <FormSection title="Submission Metadata">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
              <Field label="Source">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38 }}>
                  <Pill tone={SOURCE_TONE[source]}>{SOURCE_LABEL[source]}</Pill>
                </div>
              </Field>
              <Field label="Submitted">
                <div style={{ display: 'flex', alignItems: 'center', height: 38, fontSize: 13, color: 'var(--ds-t2)' }}>
                  {dispute.submittedAt ? new Date(dispute.submittedAt).toLocaleString() : '—'}
                </div>
              </Field>
            </div>
            {dispute.amazonResponse && (
              <Field label="Amazon's Response">
                <div style={{ fontSize: 12.5, color: 'var(--ds-t2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {dispute.amazonResponse}
                  {dispute.amazonResponseAt && (
                    <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 4 }}>
                      Recorded {new Date(dispute.amazonResponseAt).toLocaleString()}
                      {dispute.amazonResponseBy ? ` by ${dispute.amazonResponseBy}` : ''}
                    </div>
                  )}
                </div>
              </Field>
            )}
            {dispute.externalId && (
              <Field label="External ID">
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t3)' }}>{dispute.externalId}</div>
              </Field>
            )}
          </FormSection>
        )}
      </form>
    </Modal>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────

type StatusFilter = 'ALL' | DisputeStatus

export function DisputesPage() {
  const amazonDisputes      = useAppStore((s) => s.amazonDisputes)
  const addAmazonDispute    = useAppStore((s) => s.addAmazonDispute)
  const updateAmazonDispute = useAppStore((s) => s.updateAmazonDispute)
  const deleteAmazonDispute = useAppStore((s) => s.deleteAmazonDispute)
  const refreshAmazonDisputes = useAppStore((s) => s.refreshAmazonDisputes)
  const currentUserEmail    = useAppStore((s) => s.currentUserEmail)
  const drivers             = useAppStore((s) => s.drivers)

  const [search, setSearch]       = useState('')
  const [statusF, setStatusF]     = useState<StatusFilter>('ALL')
  const [newOpen, setNewOpen]     = useState(false)
  const [editItem, setEditItem]   = useState<AmazonDispute | null>(null)
  const [page, setPage]           = useState(1)
  // A status change is where Amazon's reply belongs, so the row select opens the update
  // sheet with that status preselected rather than writing a bare status on its own.
  const [statusEdit, setStatusEdit] = useState<{ dispute: AmazonDispute; status: DisputeStatus } | null>(null)
  const [evidenceView, setEvidenceView] = useState<AmazonDispute | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Poll for portal writes — public DynamoDB mutations do not trigger GraphQL subscriptions.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshAmazonDisputes()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [refreshAmazonDisputes])

  const doRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshAmazonDisputes()
    } finally {
      setRefreshing(false)
    }
  }

  // ── Posting a recovery onto a driver's check ───────────────────────────────────
  // Sunday weeks staff can pay a recovery out on: next week (a check built early)
  // back through ten weeks, which covers Amazon's usual dispute turnaround.
  const settlementWeeks = useMemo(() => {
    const current = sundayOf()
    const weeks: { value: string; label: string }[] = []
    for (let i = 1; i >= -10; i--) {
      const value = shiftWeek(current, i)
      weeks.push({ value, label: `${weekLabelLong(value)}${i === 0 ? ' · current week' : ''}` })
    }
    return weeks
  }, [])

  const driverOptions = useMemo(
    () => drivers
      .filter((d) => d.active !== false)
      .map((d) => ({ id: d.id, name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  )

  const settlementPicker = (d: AmazonDispute) => {
    const posted = d.settlementPeriodStart ?? null
    // A posting older than the rolling window still has to be visible, or re-saving the
    // sheet would silently pull the recovery off that check.
    const weeks = posted && !settlementWeeks.some((w) => w.value === posted)
      ? [...settlementWeeks, { value: posted, label: weekLabelLong(posted) }]
      : settlementWeeks
    return {
      weeks,
      drivers: driverOptions,
      initial: {
        periodStart: posted,
        driverId: d.settlementDriverId ?? matchDisputeDriver(d.driverName, drivers)?.id ?? null,
      },
      posted: Boolean(d.settlementTripId),
    }
  }

  /**
   * One save: the dispute row, plus the DISPUTE shipment row that carries the recovery
   * onto a weekly settlement. The trip id lives on the dispute, so a second save moves
   * or re-prices that same row — and clearing the week (or leaving PAID) deletes it.
   */
  const saveStatusUpdate = async (
    dispute: AmazonDispute, patch: DisputePatch, choice: SettlementChoice | null,
  ) => {
    const existingId = dispute.settlementTripId ?? null
    let settlementPatch: DisputePatch = {}

    if (choice) {
      const amount = disputeRecoveredAmount({
        resolvedAmount: patch.resolvedAmount ?? dispute.resolvedAmount,
        amountRequested: dispute.amountRequested,
      })
      if (amount == null) throw new Error('No recovered amount to add to a settlement')
      const input = disputeTripInput({
        dispute, driverId: choice.driverId, periodStart: choice.periodStart, amount,
      })
      let tripId = existingId
      if (tripId) {
        try {
          await updateAmazonTrip(tripId, input)
        } catch (err) {
          // Only a row someone deleted on the settlement page gets written fresh; any
          // other failure surfaces, so a network error can never pay the recovery twice.
          if (!/conditional|not found|does not exist/i.test(errorMessage(err))) throw err
          tripId = null
        }
      }
      if (!tripId) tripId = (await createAmazonTrip(input)).id
      settlementPatch = {
        settlementTripId: tripId,
        settlementPeriodStart: choice.periodStart,
        settlementDriverId: choice.driverId,
      }
    } else if (existingId) {
      await deleteAmazonTrip(existingId)
      settlementPatch = { settlementTripId: null, settlementPeriodStart: null, settlementDriverId: null }
    }

    await updateAmazonDispute(dispute.id, { ...patch, ...settlementPatch })
    if (choice) toast.success(`Added to the ${weekLabelLong(choice.periodStart)} settlement`)
    else if (existingId) toast.success('Removed from the settlement')
  }

  /**
   * Deleting a dispute takes its settlement shipment with it: a DISPUTE row nobody can
   * trace back would keep inflating that week's gross and the driver's check.
   */
  const removeDispute = async (d: AmazonDispute) => {
    if (d.settlementTripId) await deleteAmazonTrip(d.settlementTripId)
    await deleteAmazonDispute(d.id)
  }

  /**
   * The edit sheet has no settlement picker, so it keeps an existing posting honest:
   * a status that is no longer PAID drops the shipment, and a re-keyed recovery amount
   * re-prices it on the week it was posted to.
   */
  const saveDisputeEdit = async (d: AmazonDispute, data: DisputeData) => {
    const tripId = d.settlementTripId ?? null
    if (!tripId) { await updateAmazonDispute(d.id, data); return }

    const amount = data.status === 'PAID'
      ? disputeRecoveredAmount({ resolvedAmount: data.resolvedAmount, amountRequested: data.amountRequested })
      : null
    if (amount == null) {
      await deleteAmazonTrip(tripId)
      await updateAmazonDispute(d.id, {
        ...data, settlementTripId: null, settlementPeriodStart: null, settlementDriverId: null,
      })
      toast.success('Removed from the settlement')
      return
    }
    await updateAmazonTrip(tripId, disputeTripInput({
      dispute: { ...d, ...data },
      driverId: d.settlementDriverId!,
      periodStart: d.settlementPeriodStart!,
      amount,
    }))
    await updateAmazonDispute(d.id, data)
  }

  const filtered = useMemo(() => {
    return amazonDisputes
      .filter((d) => statusF === 'ALL' || statusOf(d) === statusF)
      .filter((d) => {
        if (!search) return true
        const q = search.toLowerCase()
        return (
          d.driverName.toLowerCase().includes(q) ||
          (d.tripNumber ?? '').toLowerCase().includes(q) ||
          (d.description ?? '').toLowerCase().includes(q) ||
          (d.payPeriod ?? '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => (b.submittedAt ?? b.createdAt).localeCompare(a.submittedAt ?? a.createdAt))
  }, [amazonDisputes, statusF, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const paged = useMemo(() => {
    return filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  }, [filtered, safePage])

  // KPIs (over ALL disputes, not the current filter)
  const pendingCount   = amazonDisputes.filter((d) => statusOf(d) === 'PENDING').length
  const openRequested  = amazonDisputes
    .filter((d) => statusOf(d) === 'PENDING' || statusOf(d) === 'POSTED')
    .reduce((s, d) => s + (d.amountRequested ?? 0), 0)
  const recovered      = amazonDisputes
    .filter((d) => statusOf(d) === 'PAID')
    .reduce((s, d) => s + (d.resolvedAmount ?? d.amountRequested ?? 0), 0)

  const KPIS = [
    { label: 'Total Disputes', value: String(amazonDisputes.length), color: '#a78bfa' },
    { label: 'Pending',        value: String(pendingCount),          color: '#f59e0b' },
    { label: 'Open Requested', value: fmtMoney(openRequested),       color: '#1ea8f3' },
    { label: 'Recovered',      value: fmtMoney(recovered),           color: '#22c55e' },
  ]

  const FILTERS: StatusFilter[] = ['ALL', ...STATUS_ORDER]
  // The 30 s poll swaps row objects, so the open modals follow the live copy of the row.
  const statusTarget = statusEdit && (amazonDisputes.find((d) => d.id === statusEdit.dispute.id) ?? statusEdit.dispute)
  const evidenceTarget = evidenceView && (amazonDisputes.find((d) => d.id === evidenceView.id) ?? evidenceView)

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Page header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px 12px' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Amazon Disputes</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
              Driver-submitted pay disputes · arrive from the{' '}
              <a href="/amazon-disputes" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ds-blue)' }}>driver portal</a>
              {' '}or the legacy Google Form
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => void doRefresh()}
              disabled={refreshing}
              title="Refresh list"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px',
                background: 'var(--ds-surface)', border: '1px solid var(--ds-border-strong)',
                borderRadius: 8, fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)',
                cursor: refreshing ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
            <a
              href="/amazon-disputes"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px',
                background: 'var(--ds-surface)', border: '1px solid var(--ds-border-strong)',
                borderRadius: 8, fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)',
                textDecoration: 'none', fontFamily: 'inherit',
              }}
            >
              <Link2 size={14} /> Driver Portal
            </a>
            <button
              onClick={() => setNewOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-blue)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              <Plus size={14} /> New Dispute
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: '0 32px 12px' }}>
          {KPIS.map((k) => (
            <div key={k.label} style={{ position: 'relative', overflow: 'hidden', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: k.color }} />
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ds-t3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginLeft: 4 }}>{k.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: k.color, letterSpacing: '-0.02em', marginTop: 4, marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '24px 32px', maxWidth: 1360 }}>
        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search driver, trip, description…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }}
              style={{ width: 280, height: 34, paddingLeft: 30, paddingRight: 10, boxSizing: 'border-box', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7, fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {FILTERS.map((f) => {
              const active = statusF === f
              return (
                <button
                  key={f}
                  onClick={() => { setStatusF(f); setPage(1) }}
                  style={{ height: 34, padding: '0 12px', borderRadius: 7, border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`, background: active ? 'var(--ds-blue)' : 'var(--ds-surface)', color: active ? '#fff' : 'var(--ds-t2)', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  {f === 'ALL' ? 'All' : STATUS_LABEL[f]}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <FileWarning className="size-8 opacity-20" />
              <p className="text-sm">No disputes found.</p>
              <p className="text-xs text-slate-400">Disputes arrive automatically when a driver submits the portal or Google Form, or add one manually.</p>
            </div>
          ) : (
            <>
              <div style={{ maxHeight: 'calc(100vh - 340px)', overflow: 'auto' }}>
                {/* Ten columns that fit a 1440 window with the sidebar open: the filing
                    date rides under the source pill and the shipment date sits above its
                    7-day period, so Status and the row actions stay on screen. Every
                    fixed cell clips with an ellipsis and carries a title. */}
                <table style={{ width: '100%', minWidth: 1100, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                  <colgroup>
                    <col style={{ width: 116 }} />
                    <col style={{ width: 100 }} />
                    <col style={{ width: 150 }} />
                    <col style={{ width: 120 }} />
                    <col />
                    <col style={{ width: 84 }} />
                    <col style={{ width: 96 }} />
                    <col style={{ width: 76 }} />
                    <col style={{ width: 136 }} />
                    <col style={{ width: 84 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {['Source', 'Trip #', 'Shipment', 'Driver', 'Description', 'Paid', 'Requested', 'Proof', 'Status', ''].map((h, i) => (
                        <th key={i} style={{ ...thBase, textAlign: i === 5 || i === 6 ? 'right' : 'left' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((d) => {
                      const st = statusOf(d)
                      const src = sourceOf(d)
                      const files = d.evidence ?? []
                      const hasResponse = Boolean(d.amazonResponse) || responseEvidence(files).length > 0
                      return (
                        <tr key={d.id} className="maint-row">
                          <td style={{ ...tdBase, verticalAlign: 'top' }}>
                            <Pill tone={SOURCE_TONE[src]}>{SOURCE_LABEL[src]}</Pill>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ds-t3)', marginTop: 3 }}>
                              {(d.submittedAt ?? d.createdAt).slice(0, 10)}
                            </div>
                          </td>
                          <td title={d.tripNumber ?? undefined} style={{ ...tdBase, verticalAlign: 'top', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.tripNumber || '—'}</td>
                          <td style={{ ...tdBase, verticalAlign: 'top', overflow: 'hidden' }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>{d.shipmentDate || '—'}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {d.payPeriod ? formatPayPeriod(d.payPeriod) : '—'}
                            </div>
                          </td>
                          <td title={d.driverName} style={{ ...tdBase, verticalAlign: 'top', fontWeight: 600, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.driverName}</td>
                          {/* Clamped to two lines so one wordy dispute can't stretch the
                              whole row; the full text is on hover and in the edit sheet. */}
                          <td title={d.description ?? undefined} style={{ ...tdBase, verticalAlign: 'top', fontSize: 12.5, color: 'var(--ds-t3)', lineHeight: 1.45 }}>
                            {d.description
                              ? <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.description}</span>
                              : <span style={{ color: 'var(--ds-muted-soft)' }}>—</span>}
                          </td>
                          <td style={{ ...tdBase, verticalAlign: 'top', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>{fmtMoney(d.amountPaid)}</td>
                          <td style={{ ...tdBase, verticalAlign: 'top', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--ds-t1)', whiteSpace: 'nowrap' }}>{fmtMoney(d.amountRequested)}</td>
                          <td style={{ ...tdBase, verticalAlign: 'top' }}>
                            {/* A staff response screenshot must never push a legacy Drive
                                link out of the column — a GOOGLE_FORM row's only proof. */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {files.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setEvidenceView(d)}
                                  title="View and download the attached files"
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0,
                                    background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                                    color: 'var(--ds-blue)', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                                  }}
                                >
                                  <Paperclip size={13} /> {files.length} file{files.length === 1 ? '' : 's'}
                                </button>
                              )}
                              {d.photoUrl && (
                                <a href={d.photoUrl} target="_blank" rel="noreferrer" aria-label="View proof" title="Legacy Drive proof" style={{ color: 'var(--ds-blue)', display: 'inline-flex' }}><ExternalLink size={15} /></a>
                              )}
                              {files.length === 0 && !d.photoUrl && <span style={{ color: 'var(--ds-muted-soft)' }}>—</span>}
                            </div>
                          </td>
                          <td style={{ ...tdBase, verticalAlign: 'top' }}>
                            <StatusSelect status={st} onChange={(next) => setStatusEdit({ dispute: d, status: next })} />
                            {d.settlementPeriodStart && (
                              <div
                                title={`Paid out as a DISPUTE shipment on the ${weekLabelLong(d.settlementPeriodStart)} settlement`}
                                style={{ fontSize: 11, color: 'var(--ds-green)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              >
                                → {weekLabel(d.settlementPeriodStart)} settlement
                              </div>
                            )}
                          </td>
                          <td style={{ ...tdBase, verticalAlign: 'top', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button
                              type="button"
                              aria-label="Record Amazon response"
                              title={d.amazonResponse ? `Amazon: ${d.amazonResponse.slice(0, 160)}` : 'Record status, Amazon response and screenshot'}
                              onClick={() => setStatusEdit({ dispute: d, status: st })}
                              style={{ ...iconBtnStyle, color: hasResponse ? 'var(--ds-blue)' : 'var(--ds-t3)' }}
                            >
                              <MessageSquare size={13} />
                            </button>
                            <button aria-label="Edit dispute" disabled={deletingId === d.id} onClick={() => setEditItem(d)} style={{ ...iconBtnStyle, color: 'var(--ds-t3)', opacity: deletingId === d.id ? 0.5 : 1 }}><Pencil size={13} /></button>
                            <button
                              aria-label="Delete dispute"
                              disabled={deletingId === d.id}
                              onClick={() => {
                                setDeletingId(d.id)
                                removeDispute(d)
                                  .then(() => toast.success('Dispute deleted'))
                                  .catch((err) => toast.error(`Couldn't delete: ${errorMessage(err)}`))
                                  .finally(() => setDeletingId(null))
                              }}
                              style={{ ...iconBtnStyle, color: 'var(--ds-red)', opacity: deletingId === d.id ? 0.5 : 1, cursor: deletingId === d.id ? 'wait' : 'pointer' }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {pageCount > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderTop: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                  <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
                    {filtered.length} dispute{filtered.length === 1 ? '' : 's'} · Page {safePage} of {pageCount}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4, height: 30, padding: '0 10px',
                        borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
                        color: 'var(--ds-t2)', fontSize: 12.5, fontFamily: 'inherit',
                        cursor: safePage <= 1 ? 'not-allowed' : 'pointer', opacity: safePage <= 1 ? 0.5 : 1,
                      }}
                    >
                      <ChevronLeft size={14} /> Prev
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                      disabled={safePage >= pageCount}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4, height: 30, padding: '0 10px',
                        borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
                        color: 'var(--ds-t2)', fontSize: 12.5, fontFamily: 'inherit',
                        cursor: safePage >= pageCount ? 'not-allowed' : 'pointer', opacity: safePage >= pageCount ? 0.5 : 1,
                      }}
                    >
                      Next <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {newOpen && (
        <DisputeModal
          dispute={null}
          drivers={drivers}
          onSave={async (data) => { await addAmazonDispute(data) }}
          onClose={() => setNewOpen(false)}
        />
      )}
      {editItem && (
        <DisputeModal
          dispute={editItem}
          drivers={drivers}
          onSave={async (data) => { await saveDisputeEdit(editItem, data) }}
          onDelete={async () => { await removeDispute(editItem) }}
          onClose={() => setEditItem(null)}
        />
      )}
      {statusEdit && statusTarget && (
        <StatusUpdateModal
          dispute={statusTarget}
          initialStatus={statusEdit.status}
          statusOptions={STATUS_ORDER}
          statusLabel={STATUS_LABEL}
          actorEmail={currentUserEmail}
          settlement={settlementPicker(statusTarget)}
          onSave={async (patch: DisputePatch, choice: SettlementChoice | null) => {
            await saveStatusUpdate(statusTarget, patch, choice)
          }}
          onClose={() => setStatusEdit(null)}
        />
      )}
      {evidenceTarget && (
        <Modal
          title={`Files — ${evidenceTarget.driverName}${evidenceTarget.tripNumber ? ` · ${evidenceTarget.tripNumber}` : ''}`}
          onClose={() => setEvidenceView(null)}
          footer={
            <>
              <span />
              <button type="button" onClick={() => setEvidenceView(null)} style={btnGhost}>Close</button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <FormSection title={`Driver Upload (${portalDriverEvidence(evidenceTarget.evidence).length})`}>
              <EvidenceGallery evidence={portalDriverEvidence(evidenceTarget.evidence)} />
            </FormSection>
            {responseEvidence(evidenceTarget.evidence).length > 0 && (
              <FormSection title={`Amazon Response (${responseEvidence(evidenceTarget.evidence).length})`}>
                <EvidenceGallery evidence={responseEvidence(evidenceTarget.evidence)} />
              </FormSection>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
