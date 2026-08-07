import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { X, Upload, Eye, Download, FileText, Image as ImageIcon, RefreshCw, FileStack, Pencil, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { Avatar } from '@/components/ui/avatar'
import { getColor } from '@/lib/driverColors'
import { ACCEPTED_DOC_EXT } from '@/lib/complianceClient'
import { driverTrailerFieldDeployed } from '@/lib/apiClient'
import {
  slotsForAsset, slotsForDriver, slotState, isUnslottedDoc, DRIVER_FILE_SLOTS, driverExpiryPatch,
  visibleSlots, visibleDocs, responsibilityFor, RESPONSIBILITY_LABELS, type FileSlot, type SlotState,
} from '@/lib/fileHub'
import { evaluateTruckDoc, TRUCK_DOC_SPECS } from '@/lib/truckDocs'
import {
  downloadEntityPacket, packetToast, entityFields, fmtDate, driverForTruck,
  DRIVER_DOCS_ON_TRUCK, type FileEntity,
} from './entityPacket'
import { DriverOnboardingSection } from './DriverOnboardingSection'
import { TruckOnboardingSection } from './TruckOnboardingSection'
import { DriverApplicationView } from '@/features/compliance/DriverApplicationView'
import { PacketPickerModal } from './PacketPickerModal'
import { DocumentPreviewModal } from './DocumentPreviewModal'
import { packetItems } from './entityPacket'
import { approveDocument, rejectDocument } from '@/lib/documentReview'
import type { FileHubState } from '@/hooks/useFileHub'
import type { ComplianceDocument, Driver } from '@/types'

export type { FileEntity }

const STATE_STYLE: Record<SlotState, { fg: string; bg: string; label: string }> = {
  VALID:         { fg: '#15803d', bg: '#f0fdf4', label: 'On file' },
  EXPIRING_SOON: { fg: '#b45309', bg: '#fffbeb', label: 'Expiring soon' },
  EXPIRED:       { fg: '#b91c1c', bg: '#fef2f2', label: 'Expired' },
  MISSING:       { fg: 'var(--ds-t3)', bg: 'var(--ds-bg)', label: 'Missing' },
  WAIVED:        { fg: 'var(--ds-t3)', bg: 'var(--ds-bg)', label: 'Not required' },
  PENDING_REVIEW:{ fg: '#b45309', bg: '#fffbeb', label: 'To review' },
}

const getInitials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'

const todayIso = () => new Date().toISOString().slice(0, 10)

export function EntityFilePanel({ entity, hub, onClose, onEditDriver, canSeePrivate = false }: {
  entity: FileEntity
  hub: FileHubState
  onClose: () => void
  /** Opens the full driver editor (phone, CDL, truck, trailer, colour, photo…). */
  onEditDriver?: (driver: Driver) => void
  /** False for non-admins: private documents are hidden completely, not shown missing. */
  canSeePrivate?: boolean
}) {
  const { user } = useAuth()
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const updateDriver = useAppStore((s) => s.updateDriver)
  const updateEquipment = useAppStore((s) => s.updateEquipment)

  const entityType = entity.kind
  const entityId = entity.kind === 'DRIVER' ? entity.driver.id : entity.truck.id
  const title = entity.kind === 'DRIVER' ? entity.driver.name : `Truck ${entity.truck.unitNumber}`

  const allSlots = entity.kind === 'TRUCK'
    ? slotsForAsset(entity.truck.type, entity.truck.fleetGroup)
    : slotsForDriver(entity.kind === 'DRIVER' ? entity.driver.fleetGroup : null)
  // Private documents vanish for non-admins — no tile, no "missing" placeholder that
  // would reveal the document exists at all.
  const slots = visibleSlots(allSlots, canSeePrivate)
  const [busySlot, setBusySlot] = useState<string | null>(null)
  // A dated document needs its expiration captured at upload, so it can be stored on
  // the document AND written back to the driver record (they used to drift apart).
  const [pending, setPending] = useState<{ slot: FileSlot; file: File; expiration: string } | null>(null)
  const [packetBusy, setPacketBusy] = useState(false)
  const [pickingPacket, setPickingPacket] = useState(false)
  const [preview, setPreview] = useState<ComplianceDocument | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const targetSlot = useRef<FileSlot | null>(null)

  const trailers = useMemo(
    () => equipment.filter((e) => e.type === 'trailer')
      .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [equipment],
  )

  // Details shown at the top of the panel — and reused verbatim on the packet cover.
  const fields = useMemo(() => entityFields(entity, drivers, equipment), [entity, drivers, equipment])

  const otherDocs = useMemo(
    () => visibleDocs(hub.docsForEntity(entityType, entityId).filter((d) => isUnslottedDoc(d.documentType) && d.s3Key), canSeePrivate),
    [hub, entityType, entityId, canSeePrivate],
  )

  // On a truck, show the assigned driver's CDL and medical card in context.
  const assignedDriver = entity.kind === 'TRUCK' ? driverForTruck(entity.truck, drivers) : undefined
  const driverDocsOnTruck = useMemo(() => {
    if (!assignedDriver) return []
    return DRIVER_DOCS_ON_TRUCK.map((key) => ({
      key,
      label: DRIVER_FILE_SLOTS.find((s) => s.key === key)?.label ?? key,
      doc: hub.docFor('DRIVER', assignedDriver.id, key),
    }))
  }, [assignedDriver, hub])

  // ── Actions ───────────────────────────────────────────────────────────────────

  const pickFile = (slot: FileSlot) => {
    targetSlot.current = slot
    fileRef.current?.click()
  }

  /** DOT's date lives on the truck, so it is never asked for here. */
  const needsExpiration = (slot: FileSlot) =>
    slot.expires && !TRUCK_DOC_SPECS.find((sp) => sp.key === slot.key)?.dot

  const onFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const slot = targetSlot.current
    e.target.value = ''
    targetSlot.current = null
    if (!file || !slot) return

    if (needsExpiration(slot)) {
      // Replacing offers the CURRENT document's date so it's visible and easy to change;
      // a first upload falls back to the driver record.
      const existing = hub.docFor(entityType, entityId, slot.key)?.expirationDate
      const record = entity.kind === 'DRIVER'
        ? (slot.key === 'cdl_copy' ? entity.driver.cdlExpiration : slot.key === 'medical_card' ? entity.driver.medCardExpiration : null)
        : null
      setPending({ slot, file, expiration: (existing ?? record ?? '').slice(0, 10) })
      return
    }
    void doUpload(slot, file, null)
  }

  const doUpload = async (slot: FileSlot, file: File, expiration: string | null) => {
    setBusySlot(slot.key)
    try {
      await hub.upload({
        entityType, entityId,
        documentType: slot.key,
        title: slot.label,
        file,
        expirationDate: expiration,
        uploadedByUser: user?.email ?? null,
      })

      // Keep the driver record's copy of this date in step with the document.
      const driverId = entity.kind === 'DRIVER' ? entity.driver.id : null
      const patch = driverId ? driverExpiryPatch(slot.key, expiration) : null
      if (patch && driverId) {
        try {
          await updateDriver(driverId, patch)
        } catch (err) {
          // The document IS saved — say so rather than implying the upload failed.
          toast.warning(`${slot.label} uploaded, but the driver record's date could not be updated: ${err instanceof Error ? err.message : 'unknown error'}`)
          setPending(null)
          return
        }
      }
      toast.success(`${slot.label} uploaded${patch ? ' · driver record updated' : ''}`)
      setPending(null)
    } catch (err) {
      toast.error(`Couldn't upload ${slot.label}: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setBusySlot(null)
    }
  }

  const openDoc = async (doc: ComplianceDocument, mode: 'view' | 'download') => {
    if (!doc.s3Key) return
    // Preview in place — opening a tab lost your position in the file.
    if (mode === 'view') { setPreview(doc); return }
    try {
      const url = await hub.urlFor(doc.s3Key)
      const a = document.createElement('a')
      a.href = url
      a.download = doc.s3Key.split('/').pop() ?? doc.title
      a.click()
    } catch (err) {
      toast.error(`Couldn't open ${doc.title}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const buildPacket = async (include?: { fieldLabels: string[]; itemLabels: string[] }) => {
    setPacketBusy(true)
    setPickingPacket(false)
    try {
      const outcome = await downloadEntityPacket({ entity, hub, drivers, equipment, todayIso: todayIso(), canSeePrivate, include })
      const { level, message } = packetToast(outcome)
      toast[level](message)
    } catch (err) {
      toast.error(`Couldn't build the packet: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setPacketBusy(false)
    }
  }

  // ── Truck editing, carried over from the old Asset Documents table ─────────────
  // DOT inspection date lives on the truck (and syncs with the Fleet page); expiration
  // dates and waivers live on the document. Both were editable inline before this page
  // adopted the Files layout, and Jason's workflow depends on them.
  const setDotDate = (date: string) => {
    if (entity.kind !== 'TRUCK') return
    updateEquipment(entity.truck.id, { dotInspectionDate: date || undefined })
    toast.success(date ? 'DOT inspection date updated' : 'DOT inspection date cleared')
  }

  const setAssignee = (value: string) => {
    if (entity.kind !== 'TRUCK') return
    updateEquipment(entity.truck.id, { fleetManagerAssignee: value || undefined })
  }

  const setExpiration = async (doc: ComplianceDocument, date: string) => {
    try {
      await hub.setExpiration(doc, date || null)
      toast.success('Expiration updated')
    } catch (err) {
      toast.error(`Couldn't update the date: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const toggleWaived = async (slot: FileSlot, doc: ComplianceDocument | undefined) => {
    try {
      await hub.setWaived(entityType, entityId, slot.key, slot.label, doc, doc?.status !== 'WAIVED')
      toast.success(doc?.status === 'WAIVED' ? `${slot.label} is required again` : `${slot.label} marked not required`)
    } catch (err) {
      toast.error(`Couldn't update ${slot.label}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  /**
   * Review a driver-uploaded document without leaving the file. Shares the rules with
   * the Review Queue (documentReview.ts) so approving here also settles the checklist
   * item, writes the audit entry, and — on rejection — emails the driver the reason.
   */
  const review = async (doc: ComplianceDocument, decision: 'approve' | 'reject') => {
    let reason = ''
    if (decision === 'reject') {
      reason = window.prompt('Why is this being sent back? The driver is emailed this reason.')?.trim() ?? ''
      if (!reason) return   // no silent rejection — they'd never know to fix it
    }
    setBusySlot(doc.documentType)
    try {
      if (decision === 'approve') await approveDocument(doc, user?.email)
      else await rejectDocument(doc, reason, user?.email)
      await hub.refresh()
      toast.success(decision === 'approve' ? 'Document approved' : 'Sent back to the driver')
    } catch (err) {
      toast.error(`Couldn't ${decision} it: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally { setBusySlot(null) }
  }

  const removeDocument = async (doc: ComplianceDocument, label: string) => {
    if (!window.confirm(`Delete the ${label} on file?\n\nThe file is removed and its checklist item reopens. This can't be undone.`)) return
    setBusySlot(doc.documentType)
    try {
      await hub.remove(doc)
      toast.success(`${label} deleted`)
    } catch (err) {
      toast.error(`Couldn't delete it: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally { setBusySlot(null) }
  }

  const setTrailer = async (trailerId: string) => {
    if (entity.kind !== 'DRIVER') return
    try {
      await updateDriver(entity.driver.id, { assignedTrailerId: trailerId || null })
      toast.success(trailerId ? 'Trailer assigned' : 'Trailer set back to TBD')
    } catch (err) {
      toast.error(`Couldn't save the trailer: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const color = entity.kind === 'DRIVER' ? getColor(entity.driver.colorKey) : null

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 620, height: '100%', background: 'var(--ds-surface)', boxShadow: 'var(--sh-lg, -10px 0 40px rgba(0,0,0,0.2))', display: 'flex', flexDirection: 'column' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--ds-border)' }}>
          {entity.kind === 'DRIVER' && color && (
            <Avatar src={entity.driver.photoUrl} initials={getInitials(entity.driver.name)} size="lg" style={{ background: color.avatarBg, color: '#fff' }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{entity.kind === 'DRIVER' ? 'Driver file' : 'Truck file'}</div>
          </div>
          {entity.kind === 'DRIVER' && onEditDriver && (
            <button onClick={() => onEditDriver(entity.driver)} title="Edit phone, CDL, truck, trailer and more"
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              <Pencil size={14} /> Edit
            </button>
          )}
          {/* Deliberately understated: the one-click path is unchanged and this only
              appears as a small link for the times a packet needs trimming. */}
          <button onClick={() => setPickingPacket(true)} disabled={packetBusy}
            title="Choose what goes in the PDF"
            style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', padding: 0 }}>
            Choose…
          </button>
          <button onClick={() => void buildPacket()} disabled={packetBusy}
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: packetBusy ? 'wait' : 'pointer', opacity: packetBusy ? 0.7 : 1, fontFamily: 'inherit' }}>
            <FileStack size={14} /> {packetBusy ? 'Building…' : 'Download packet'}
          </button>
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Details */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', marginBottom: 20 }}>
            {fields.map((f) => (
              <div key={f.label}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{f.label}</div>
                <div style={{ fontSize: 13.5, color: f.value ? 'var(--ds-t1)' : 'var(--ds-t3)', marginTop: 2 }}>{f.value || '—'}</div>
              </div>
            ))}
          </div>

          {entity.kind === 'DRIVER' && (
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Assign trailer</div>
              <select
                value={entity.driver.assignedTrailerId ?? ''}
                onChange={(e) => setTrailer(e.target.value)}
                disabled={!driverTrailerFieldDeployed()}
                style={{ height: 34, width: '100%', maxWidth: 280, borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontFamily: 'inherit' }}>
                <option value="">TBD — not assigned</option>
                {trailers.map((t) => <option key={t.id} value={t.id}>{t.unitNumber}{t.nickname ? ` · ${t.nickname}` : ''}</option>)}
              </select>
              {!driverTrailerFieldDeployed() && (
                <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 5 }}>Trailer assignment needs the latest backend deploy before it can be saved.</div>
              )}
            </div>
          )}

          {entity.kind === 'TRUCK' && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Last DOT inspection</div>
                <input type="date" value={entity.truck.dotInspectionDate ?? ''} onChange={(e) => setDotDate(e.target.value)}
                  title="Last DOT inspection — syncs with the Fleet page"
                  style={{ height: 34, borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontFamily: 'inherit' }} />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Fleet manager</div>
                <select value={entity.truck.fleetManagerAssignee ?? ''} onChange={(e) => setAssignee(e.target.value)}
                  style={{ height: 34, minWidth: 140, borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontFamily: 'inherit', textTransform: 'capitalize' }}>
                  <option value="">Unassigned</option>
                  <option value="jason">Jason</option>
                  <option value="ryne">Ryne</option>
                </select>
              </div>
            </div>
          )}

          {entity.kind === 'DRIVER'
            ? <DriverOnboardingSection driver={entity.driver} />
            : <TruckOnboardingSection asset={entity.truck} />}

          {/* The submitted DOT application, reviewable next to the documents it produced
              — it used to live only on the Compliance pages. */}
          {entity.kind === 'DRIVER' && (
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Application</div>
              <DriverApplicationView driverId={entity.driver.id} />
            </div>
          )}

          {/* Document slots */}
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Documents</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            {slots.map((slot) => {
              const doc = hub.docFor(entityType, entityId, slot.key)
              // Trucks go through the Asset Documents evaluator so both pages agree.
              const evalResult = entity.kind === 'TRUCK'
                ? evaluateTruckDoc(entity.truck, TRUCK_DOC_SPECS.find((s) => s.key === slot.key)!, doc)
                : null
              const state: SlotState = evalResult ? (evalResult.state as SlotState) : slotState(doc)
              // DOT's date lives on the truck, not the document.
              const shownExpiry = evalResult?.expiration ?? doc?.expirationDate ?? null
              const style = STATE_STYLE[state]
              const busy = busySlot === slot.key
              const Icon = slot.kind === 'photo' ? ImageIcon : FileText
              return (
                <div key={slot.key}
                  style={{ border: `1px solid ${state === 'MISSING' ? 'var(--ds-border)' : style.fg + '55'}`, borderRadius: 10, padding: 11, background: state === 'MISSING' ? 'var(--ds-bg)' : 'var(--ds-surface)', display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon size={14} style={{ color: 'var(--ds-t3)', flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{slot.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{slot.sub}</div>
                  <div style={{ fontSize: 10, color: 'var(--ds-t3)' }}>
                    {RESPONSIBILITY_LABELS[responsibilityFor(slot.key)]}
                  </div>
                  <span style={{ alignSelf: 'flex-start', fontSize: 10.5, fontWeight: 600, color: style.fg, background: style.bg, padding: '2px 7px', borderRadius: 999 }}>
                    {style.label}{shownExpiry && state !== 'MISSING' ? ` · ${fmtDate(shownExpiry)}` : ''}
                  </span>

                  {/* Expiration is editable for dated paperwork (not photos, and not
                      DOT — whose date comes from the truck field above). */}
                  {doc?.s3Key && slot.expires && !TRUCK_DOC_SPECS.find((s) => s.key === slot.key)?.dot && (
                    <input type="date" value={doc.expirationDate ?? ''} onChange={(e) => setExpiration(doc, e.target.value)}
                      title="Expiration date"
                      style={{ height: 28, width: '100%', borderRadius: 6, border: '1px solid var(--ds-border)', padding: '0 6px', fontSize: 11.5, background: 'var(--ds-bg)', color: 'var(--ds-t1)', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                  )}

                  <button onClick={() => toggleWaived(slot, doc)}
                    style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, fontSize: 11, color: 'var(--ds-t3)', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>
                    {state === 'WAIVED' ? 'Mark required' : 'Not required'}
                  </button>

                  {doc?.status === 'PENDING_REVIEW' && (
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button onClick={() => void review(doc, 'approve')} disabled={busy}
                        style={{ flex: 1, height: 26, borderRadius: 6, border: 'none', background: '#15803d', color: '#fff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Approve</button>
                      <button onClick={() => void review(doc, 'reject')} disabled={busy}
                        style={{ flex: 1, height: 26, borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: '#b91c1c', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Send back</button>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 5, marginTop: 'auto', paddingTop: 4 }}>
                    {doc?.s3Key ? (
                      <>
                        <button onClick={() => openDoc(doc, 'view')} title="Preview" aria-label={`Preview ${slot.label}`}
                          style={iconAction}><Eye size={13} /></button>
                        <button onClick={() => openDoc(doc, 'download')} title="Download" aria-label={`Download ${slot.label}`}
                          style={iconAction}><Download size={13} /></button>
                        <button onClick={() => pickFile(slot)} disabled={busy} title="Replace with a new file and date" aria-label={`Replace ${slot.label}`}
                          style={iconAction}><RefreshCw size={13} /></button>
                        <button onClick={() => void removeDocument(doc, slot.label)} disabled={busy}
                          title="Delete" aria-label={`Delete ${slot.label}`}
                          style={{ ...iconAction, color: '#b91c1c' }}><Trash2 size={13} /></button>
                      </>
                    ) : (
                      <button onClick={() => pickFile(slot)} disabled={busy}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, width: '100%', height: 28, borderRadius: 7, border: '1px dashed var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-blue)', fontSize: 12, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                        <Upload size={12} /> {busy ? 'Uploading…' : 'Upload'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* The assigned driver's own documents, shown on the truck for context.
              These are the SAME records as the driver's file — read-only here so there
              is exactly one place to upload them. */}
          {assignedDriver && driverDocsOnTruck.length > 0 && (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '22px 0 8px' }}>
                Driver documents · {assignedDriver.name}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {driverDocsOnTruck.map(({ key, label, doc }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid var(--ds-border)' }}>
                    <FileText size={13} style={{ color: 'var(--ds-t3)', flexShrink: 0 }} />
                    <span style={{ flex: 1, color: doc ? 'var(--ds-t2)' : 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {label}
                      {doc?.expirationDate
                        ? <span style={{ color: 'var(--ds-t3)' }}> · expires {fmtDate(doc.expirationDate)}</span>
                        : !doc && <span style={{ color: 'var(--ds-t3)' }}> · not on file</span>}
                    </span>
                    {doc?.s3Key && (
                      <>
                        <button onClick={() => openDoc(doc, 'view')} title="Preview" style={iconAction}><Eye size={13} /></button>
                        <button onClick={() => openDoc(doc, 'download')} title="Download" style={iconAction}><Download size={13} /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 6 }}>
                Upload these on {assignedDriver.name}'s driver file — they're the same records, so one upload covers both.
              </div>
            </>
          )}

          {/* Anything else already on file for this entity, from other pages */}
          {otherDocs.length > 0 && (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '22px 0 8px' }}>
                Other documents on file
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {otherDocs.map((doc) => (
                  <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid var(--ds-border)' }}>
                    <FileText size={13} style={{ color: 'var(--ds-t3)', flexShrink: 0 }} />
                    <span style={{ flex: 1, color: 'var(--ds-t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {doc.title || doc.documentType}
                      {doc.expirationDate && <span style={{ color: 'var(--ds-t3)' }}> · expires {fmtDate(doc.expirationDate)}</span>}
                    </span>
                    <button onClick={() => openDoc(doc, 'view')} title="Preview" style={iconAction}><Eye size={13} /></button>
                    <button onClick={() => openDoc(doc, 'download')} title="Download" style={iconAction}><Download size={13} /></button>
                    <button onClick={() => void removeDocument(doc, doc.title || doc.documentType)}
                      title="Delete" style={{ ...iconAction, color: '#b91c1c' }}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          <p style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 22, lineHeight: 1.5 }}>
            Uploads here go to the same place as Compliance, Onboarding and Asset Documents — upload once and it shows
            everywhere. The packet is a single PDF: cover sheet, then every document above.
          </p>
        </div>

        {preview && (
          <DocumentPreviewModal doc={preview} getUrl={hub.urlFor} onClose={() => setPreview(null)} />
        )}

        {pickingPacket && (
          <PacketPickerModal
            title={title}
            fields={entityFields(entity, drivers, equipment)}
            items={packetItems(entity, hub, drivers, canSeePrivate)}
            missing={(() => {
              const included = new Set(packetItems(entity, hub, drivers, canSeePrivate).map((i) => i.label))
              return slots.filter((sl) => !included.has(sl.label)).map((sl) => sl.label)
            })()}
            onCancel={() => setPickingPacket(false)}
            onBuild={(chosen) => void buildPacket(chosen)}
          />
        )}

        <input ref={fileRef} type="file" accept={ACCEPTED_DOC_EXT} onChange={onFileChosen} style={{ display: 'none' }} />

        {/* Confirm the expiration before saving a dated document. The date is stored on
            the document and, for a driver's CDL / medical card, written to the driver
            record too so the two can't drift. */}
        {pending && (
          <div onClick={() => setPending(null)}
            style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ background: 'var(--ds-surface)', borderRadius: 12, border: '1px solid var(--ds-border)', width: 420, maxWidth: '92vw', overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>{pending.slot.label}</div>
                <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pending.file.name}</div>
              </div>
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Expiration date</label>
                <input type="date" value={pending.expiration}
                  onChange={(e) => setPending((p) => (p ? { ...p, expiration: e.target.value } : p))}
                  style={{ height: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)', fontSize: 13, fontFamily: 'inherit' }} />
                {entity.kind === 'DRIVER' && driverExpiryPatch(pending.slot.key, pending.expiration) && (
                  <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
                    This also updates {entity.driver.name}'s {pending.slot.key === 'cdl_copy' ? 'CDL' : 'medical card'} expiration on their driver record.
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>Leave blank if this document doesn't expire.</div>
              </div>
              <div style={{ padding: '12px 20px', borderTop: '1px solid var(--ds-border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setPending(null)} disabled={!!busySlot}
                  style={{ height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                <button onClick={() => doUpload(pending.slot, pending.file, pending.expiration || null)} disabled={!!busySlot}
                  style={{ height: 34, padding: '0 18px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: busySlot ? 'wait' : 'pointer', opacity: busySlot ? 0.6 : 1, fontFamily: 'inherit' }}>
                  {busySlot ? 'Uploading…' : 'Save & upload'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const iconAction: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, borderRadius: 7, border: '1px solid var(--ds-border)',
  background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer', flexShrink: 0,
}
