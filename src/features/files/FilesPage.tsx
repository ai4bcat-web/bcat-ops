import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Search, Users, Truck as TruckIcon, Container, FileStack, UserPlus, EyeOff } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useFileHub } from '@/hooks/useFileHub'
import { Avatar } from '@/components/ui/avatar'
import { getColor } from '@/lib/driverColors'
import { formatVin } from '@/lib/utils'
import {
  slotsForDriver, slotsForAsset, readyScore, slotState, truckSlotState, driverExpiry, visibleSlots,
  type ReadyScore, type SlotState, type ExpiryInfo,
} from '@/lib/fileHub'
import { DRIVER_FLEET_LABELS } from '@/lib/fleetGroups'
import { listAllOnboardingTasks } from '@/lib/complianceClient'
import { listDriverPaySettings } from '@/lib/apiClient'
import { onboardingProgress, driverStatus, DRIVER_STATUS_LABELS, resolveDriverEmail, type DriverStatus } from '@/lib/driverOnboarding'
import type { OnboardingTask } from '@/types'
import { EntityFilePanel } from './EntityFilePanel'
import { DriverDrawer } from '@/features/drivers/DriverDrawer'
import { TmsAlert } from '@/features/tms/kit/TmsAlert'
import { TmsBadge, type TmsTone } from '@/features/tms/kit/TmsBadge'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { TmsInput } from '@/features/tms/kit/TmsInput'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { PrivateDocsModal } from './PrivateDocsModal'
import { InviteDriverModal } from './InviteDriverModal'
import { IvanPhones } from '@/features/driver-info/IvanPhones'
import { DriverPhones } from '@/components/DriverPhones'
import { useDriverPhones } from '@/hooks/useTruckConfigs'
import { useComplianceSettings } from '@/hooks/useComplianceSettings'
import { downloadEntityPacket, packetToast, driverForTruck, type FileEntity } from './entityPacket'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'

/**
 * TRAILER is a third tab rather than a filter on TRUCK: trailers carry a different set
 * of documents (no IFTA or I-PASS; a dock plate instead), so mixing them into one list
 * would show columns that don't apply to half the rows.
 */
type Tab = 'DRIVER' | 'TRUCK' | 'TRAILER'

const getInitials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'

const TH: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase',
  letterSpacing: '0.04em', padding: '8px 10px', textAlign: 'left', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--tms-text)', padding: '9px 10px', textAlign: 'left' }

/** ●●●○○ — filled per required slot on file, amber when something needs attention. */
function ReadyDots({ score }: { score: ReadyScore }) {
  const color = score.missing > 0 ? 'var(--tms-muted)' : score.attention > 0 ? 'var(--tms-badge-orange)' : 'var(--tms-badge-green)'
  return (
    <span title={`${score.onFile} of ${score.required} on file${score.attention ? ` · ${score.attention} need attention` : ''}`}
      style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {Array.from({ length: score.required }, (_, i) => (
        <span key={i} style={{
          width: 7, height: 7, borderRadius: '50%',
          background: i < score.onFile ? color : 'transparent',
          border: i < score.onFile ? 'none' : '1px solid var(--tms-border)',
        }} />
      ))}
      <span style={{ fontSize: 11.5, color: 'var(--tms-muted)', marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>
        {score.onFile}/{score.required}
      </span>
    </span>
  )
}

const EXPIRY_TONE: Record<SlotState, TmsTone> = {
  VALID: 'green',
  EXPIRING_SOON: 'orange',
  EXPIRED: 'red',
  MISSING: 'gray',
  WAIVED: 'gray',
  PENDING_REVIEW: 'orange',
}

const shortDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', timeZone: 'UTC' })

/** The same expiry chip, sized to sit under a value rather than in its own column. */
function ExpiryInline({ info }: { info: ExpiryInfo }) {
  if (!info.date) return <div style={{ fontSize: 11, color: 'var(--tms-muted)' }}>no expiry</div>
  return (
    <div style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
      <TmsBadge tone={EXPIRY_TONE[info.state]}>{shortDate(info.date)}{info.conflict && ' ⚠'}</TmsBadge>
    </div>
  )
}

/** A driver's CDL / med-card expiry, colour-coded, flagging a record-vs-document mismatch. */
function ExpiryCell({ info }: { info: ExpiryInfo }) {
  if (!info.date) {
    return <td style={{ ...TD, color: 'var(--tms-muted)' }}>—</td>
  }
  return (
    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
      <TmsBadge tone={EXPIRY_TONE[info.state]} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {shortDate(info.date)}
      </TmsBadge>
      {info.conflict && (
        <span
          title={`The driver record says ${info.recordDate} but the uploaded document says ${info.documentDate}. Showing the driver record — fix whichever is wrong.`}
          style={{ marginLeft: 5, fontSize: 11, color: 'var(--tms-badge-orange)', cursor: 'help' }}>⚠</span>
      )}
    </td>
  )
}

/** Work (truck N) and Personal lines for one driver row; "—" when there is no number at all. */
function DriverPhoneLines({ driver, unitNumber }: { driver: Driver; unitNumber: string | null }) {
  const phones = useDriverPhones(driver, { unitNumber })
  if (!phones.truckId && !phones.personal && !phones.personalRaw) return <div style={{ color: 'var(--tms-text-2)' }}>—</div>
  return <div style={{ color: 'var(--tms-text-2)', fontSize: 12 }}><DriverPhones phones={phones} variant="stacked" /></div>
}

export function FilesPage() {
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const storeLoading = useAppStore((s) => s.isLoading)
  const storeError = useAppStore((s) => s.error)
  const hub = useFileHub()
  // Private documents (pay terms) are admin-only — hidden entirely, not shown as missing.
  const { isAdmin } = useAuth()
  // Loading settings applies the configured private-document list app-wide.
  useComplianceSettings()
  const [privateDocsOpen, setPrivateDocsOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)

  const [tab, setTab] = useState<Tab>('TRUCK')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [packetBusyId, setPacketBusyId] = useState<string | null>(null)
  // Filter the driver list by working status. 'ALL' first so the default view is
  // unchanged and nobody loses sight of a driver because a filter was remembered.
  const [statusFilter, setStatusFilter] = useState<DriverStatus | 'ALL'>('ALL')
  // The full driver editor, moved here from the retired Drivers page — the only place
  // that can create a driver or edit phone/CDL/colour/photo/classification.
  const [driverEdit, setDriverEdit] = useState<{ open: boolean; driver: Driver | null }>({ open: false, driver: null })
  // The file we came from, so closing the editor returns there instead of dumping the
  // user back on the list having lost their place.
  const [returnToDriverId, setReturnToDriverId] = useState<string | null>(null)

  // Onboarding tasks for every driver, so the Status column can tell "still onboarding"
  // from "active". One query for the list rather than one per row.
  const [tasks, setTasks] = useState<OnboardingTask[]>([])
  useEffect(() => {
    let alive = true
    listAllOnboardingTasks()
      .then((all) => { if (alive) setTasks(all.filter((t) => t.entityType === 'DRIVER')) })
      .catch((err) => console.error('[FilesPage] onboarding tasks', err))
    return () => { alive = false }
  }, [])

  // Settlement emails, so the file doesn't ask for an address that already exists on a
  // driver's pay setting.
  const [payEmails, setPayEmails] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    let alive = true
    listDriverPaySettings()
      .then((all) => {
        if (!alive) return
        const map = new Map<string, string>()
        for (const st of all) if (st.email?.trim()) map.set(st.driverId, st.email.trim())
        setPayEmails(map)
      })
      .catch((err) => console.error('[FilesPage] pay settings', err))
    return () => { alive = false }
  }, [])

  const emailOf = useCallback((d: Driver) => resolveDriverEmail(d, payEmails.get(d.id)), [payEmails])

  const tasksByDriver = useMemo(() => {
    const map = new Map<string, OnboardingTask[]>()
    for (const t of tasks) {
      const list = map.get(t.entityId)
      if (list) list.push(t); else map.set(t.entityId, [t])
    }
    return map
  }, [tasks])

  const statusOf = useCallback((d: Driver): { status: DriverStatus; percent: number } => {
    const progress = onboardingProgress(tasksByDriver.get(d.id) ?? [])
    return { status: driverStatus(d, progress), percent: progress.percent }
  }, [tasksByDriver])

  const trucks = useMemo(
    () => equipment.filter((e) => e.type === 'truck' && e.active !== false)
      .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [equipment],
  )
  const trailers = useMemo(() => equipment.filter((e) => e.type === 'trailer'), [equipment])
  // Every active trailer in the fleet, so what the Fleet Manager dashboard shows is
  // reachable here too.
  const activeTrailers = useMemo(
    () => equipment.filter((e) => e.type === 'trailer' && e.active !== false)
      .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [equipment],
  )

  // EVERY driver (brokers aside — they're a calendar construct, not people). Inactive
  // drivers must be in the base list or the Inactive tab has nothing to show and "All"
  // quietly omits them, which is how a deactivated driver disappeared from the app.
  const activeDrivers = useMemo(
    () => drivers.filter((d) => d.type !== 'broker')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  )

  // Trucks resolve status through truckSlotState so the dots agree exactly with the
  // Asset Documents page (DOT date comes off the truck, waived docs drop out).
  const scoreFor = (entityType: Tab, id: string): ReadyScore => {
    if (entityType === 'TRUCK') {
      const t = equipment.find((e) => e.id === id)
      if (!t) return { onFile: 0, required: 0, missing: 0, attention: 0 }
      return readyScore(visibleSlots(slotsForAsset(t.type, t.fleetGroup), isAdmin), (key) => truckSlotState(t, key, hub.docFor('TRUCK', id, key)))
    }
    const d = drivers.find((x) => x.id === id)
    return readyScore(visibleSlots(slotsForDriver(d?.fleetGroup), isAdmin), (key) => slotState(hub.docFor('DRIVER', id, key)))
  }

  const q = query.trim().toLowerCase()
  const byStatus = useMemo(
    () => statusFilter === 'ALL' ? activeDrivers : activeDrivers.filter((d) => statusOf(d).status === statusFilter),
    [activeDrivers, statusFilter, statusOf],
  )

  const shownDrivers = useMemo(() => {
    const activeDrivers = byStatus
    if (!q) return activeDrivers
    return activeDrivers.filter((d) => {
      const truck = trucks.find((t) => t.id === d.assignedTruckId)
      const fleet = d.fleetGroup ? DRIVER_FLEET_LABELS[d.fleetGroup] : ''
      return [d.name, d.phone, emailOf(d), d.cdl, truck?.unitNumber, fleet].some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [byStatus, trucks, q, emailOf])

  const assetsForTab = tab === 'TRAILER' ? activeTrailers : trucks

  const shownTrucks = useMemo(() => {
    if (!q) return assetsForTab
    return assetsForTab.filter((t) =>
      [t.unitNumber, t.vin, t.plate, String(t.year ?? ''), t.make, t.model, t.nickname].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [assetsForTab, q])

  /** Build a packet straight from a list row, without opening the profile panel. */
  const downloadPacket = async (entity: FileEntity, id: string) => {
    setPacketBusyId(id)
    try {
      const outcome = await downloadEntityPacket({
        entity, hub, drivers, equipment, todayIso: new Date().toISOString().slice(0, 10), canSeePrivate: isAdmin,
      })
      const { level, message } = packetToast(outcome)
      toast[level](message)
    } catch (err) {
      toast.error(`Couldn't build the packet: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setPacketBusyId(null)
    }
  }

  const statusCounts = useMemo(() => {
    const counts = { ALL: activeDrivers.length, ACTIVE: 0, ONBOARDING: 0, INACTIVE: 0 }
    for (const d of activeDrivers) counts[statusOf(d).status]++
    return counts
  }, [activeDrivers, statusOf])

  const openEntity: FileEntity | null = useMemo(() => {
    if (!openId) return null
    if (tab === 'DRIVER') {
      const d = drivers.find((x) => x.id === openId)
      return d ? { kind: 'DRIVER', driver: d } : null
    }
    const t = equipment.find((x) => x.id === openId)
    return t ? { kind: 'TRUCK', truck: t } : null
  }, [openId, tab, drivers, equipment])

  const tabBtn = (t: Tab, label: string, Icon: typeof Users, count: number) => (
    <button onClick={() => { setTab(t); setOpenId(null) }}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 8,
        border: `1px solid ${tab === t ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
        background: tab === t ? 'var(--tms-primary-tint)' : 'var(--tms-card)',
        color: tab === t ? 'var(--tms-primary)' : 'var(--tms-text-2)',
        fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
      }}>
      <Icon size={14} /> {label}
      <span style={{ fontSize: 11.5, color: 'var(--tms-muted)', fontWeight: 500 }}>{count}</span>
    </button>
  )

  return (
    <TmsScrollPage
      title="Files"
      subtitle="Every document and detail on file for each driver and truck — view, download or upload what's missing. Shares one store with Compliance, Onboarding and Asset Documents, so nothing is uploaded twice."
      stickyHead
      toolbar={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {tabBtn('TRUCK', 'Trucks', TruckIcon, trucks.length)}
          {tabBtn('TRAILER', 'Trailers', Container, activeTrailers.length)}
          {tabBtn('DRIVER', 'Drivers', Users, activeDrivers.length)}
          {isAdmin && (
            <TmsButton onClick={() => setPrivateDocsOpen(true)} title="Choose which documents are hidden from everyone else">
              <EyeOff size={14} /> Private docs
            </TmsButton>
          )}
          {tab === 'DRIVER' && (
            // Drivers are never created by hand — they're invited, and their own
            // application fills in the record.
            <TmsButton variant="primary" onClick={() => setInviteOpen(true)} title="Send someone an application to fill in">
              <UserPlus size={14} /> Invite driver
            </TmsButton>
          )}
          <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--tms-muted)' }} />
            <TmsInput value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === 'DRIVER' ? 'Search name, phone, CDL, truck #' : 'Search unit #, VIN, plate, make'}
              style={{ paddingLeft: 30 }} />
          </div>
        </div>
      )}
    >
      <div>
        {storeError && (
          <TmsAlert tone="red" className="mb-3">Couldn't load drivers and loads: {storeError}</TmsAlert>
        )}
        {hub.error && (
          <TmsAlert tone="red" className="mb-3">Couldn't load documents: {hub.error}</TmsAlert>
        )}

        {/* overflow-x so a narrow window scrolls the table instead of clipping columns. */}
        <div style={{ borderRadius: 12, border: '1px solid var(--tms-border)', overflowX: 'auto', background: 'var(--tms-card)', boxShadow: 'var(--tms-shadow)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
                {tab === 'DRIVER' ? (
                  <>
                    <th style={TH}>Driver</th><th style={TH}>Type</th><th style={TH}>Contact</th>
                    <th style={TH}>CDL</th><th style={TH}>Med card</th>
                    <th style={TH}>Truck / Trailer</th><th style={TH}>Hired</th><th style={{ ...TH, textAlign: 'right' }}>On file</th>
                  </>
                ) : (
                  <>
                    <th style={TH}>Unit</th><th style={TH}>VIN</th><th style={TH}>Plate</th>
                    <th style={TH}>Make / model</th><th style={TH}>Driver</th>
                    <th style={{ ...TH, textAlign: 'right' }}>On file</th><th style={{ ...TH, width: 150 }}></th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {tab === 'DRIVER' && shownDrivers.length === 0 && (
                <tr><td colSpan={8} style={TD}>
                  <TmsEmptyState compact message={null} title={activeDrivers.length === 0
                    ? (storeLoading ? 'Loading drivers…' : 'No drivers loaded. If the roster is empty everywhere, the drivers query failed — check the console.')
                    : `No drivers match "${query}".`} />
                </td></tr>
              )}
              {tab !== 'DRIVER' && shownTrucks.length === 0 && (
                <tr><td colSpan={7} style={TD}>
                  <TmsEmptyState compact message={null} title={trucks.length === 0
                    ? (storeLoading ? 'Loading…' : `No active ${tab === 'TRAILER' ? 'trailers' : 'trucks'}.`)
                    : `No trucks match "${query}".`} />
                </td></tr>
              )}

              {tab === 'DRIVER' && shownDrivers.map((d: Driver) => {
                const truck = trucks.find((t) => t.id === d.assignedTruckId)
                const trailer = trailers.find((t) => t.id === d.assignedTrailerId)
                return (
                  <tr key={d.id} onClick={() => setOpenId(d.id)}
                    style={{ borderBottom: '1px solid var(--tms-border)', cursor: 'pointer', background: openId === d.id ? 'var(--tms-bg)' : undefined }}>
                    <td style={TD}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Avatar src={d.photoUrl} initials={getInitials(d.name)} size="xs" style={{ background: getColor(d.colorKey).avatarBg, color: 'var(--tms-on-primary)' }} />
                        <b style={{ fontWeight: 600 }}>{d.name}</b>
                      </span>
                    </td>
                    <td style={{ ...TD }}>
                      {d.fleetGroup
                        ? <TmsBadge tone="gray" style={{ whiteSpace: 'nowrap' }}>{DRIVER_FLEET_LABELS[d.fleetGroup]}</TmsBadge>
                        : <span style={{ color: 'var(--tms-muted)', fontSize: 12 }}>Unclassified</span>}
                    </td>
                    <td style={{ ...TD, maxWidth: 210 }}
                      title={emailOf(d) || 'No email — an application can’t be sent without one'}>
                      <DriverPhoneLines driver={d} unitNumber={truck?.unitNumber ?? null} />
                      <div style={{ fontSize: 11.5, color: emailOf(d) ? 'var(--tms-muted)' : 'var(--tms-badge-orange)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {emailOf(d) || 'no email'}
                      </div>
                    </td>
                    <td style={{ ...TD, maxWidth: 190 }}>
                      <div style={{ color: 'var(--tms-text-2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.cdl || '—'}
                      </div>
                      <ExpiryInline info={driverExpiry(d.cdlExpiration, hub.docFor('DRIVER', d.id, 'cdl_copy'))} />
                    </td>
                    <ExpiryCell info={driverExpiry(d.medCardExpiration, hub.docFor('DRIVER', d.id, 'medical_card'))} />
                    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--tms-text-2)' }}>{truck?.unitNumber ?? '—'}</span>
                      <span style={{ color: 'var(--tms-muted)' }}> / {trailer?.unitNumber ?? (d.bobtail ? 'Bobtail' : 'No trailer set')}</span>
                    </td>
                    <td style={{ ...TD, whiteSpace: 'nowrap', color: d.hireDate ? 'var(--tms-text-2)' : 'var(--tms-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {d.hireDate ? shortDate(d.hireDate.slice(0, 10)) : '—'}
                    </td>
                    <td style={{ ...TD, textAlign: 'right' }}><ReadyDots score={scoreFor('DRIVER', d.id)} /></td>
                  </tr>
                )
              })}

              {tab !== 'DRIVER' && shownTrucks.map((t: Equipment) => {
                const driver = driverForTruck(t, drivers)
                return (
                  <tr key={t.id} onClick={() => setOpenId(t.id)}
                    style={{ borderBottom: '1px solid var(--tms-border)', cursor: 'pointer', background: openId === t.id ? 'var(--tms-bg)' : undefined }}>
                    <td style={{ ...TD, fontWeight: 600 }}>{t.unitNumber}</td>
                    <td style={{ ...TD, color: 'var(--tms-text-2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{formatVin(t.vin) || '—'}</td>
                    <td style={{ ...TD, color: 'var(--tms-text-2)' }}>{t.plate || '—'}</td>
                    <td style={{ ...TD, color: 'var(--tms-text-2)', whiteSpace: 'nowrap' }}>{[t.year, t.make, t.model].filter(Boolean).join(' ') || '—'}</td>
                    <td style={{ ...TD, color: 'var(--tms-text-2)' }}>{driver?.name ?? '—'}</td>
                    <td style={{ ...TD, textAlign: 'right' }}><ReadyDots score={scoreFor('TRUCK', t.id)} /></td>
                    <td style={{ ...TD, textAlign: 'right', padding: '6px 10px' }}>
                      <TmsButton
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); downloadPacket({ kind: 'TRUCK', truck: t }, t.id) }}
                        disabled={packetBusyId === t.id}
                        title="Download every document for this truck as one PDF"
                        style={{ whiteSpace: 'nowrap' }}>
                        <FileStack size={13} /> {packetBusyId === t.id ? 'Building…' : 'Download full PDF'}
                      </TmsButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {tab === 'DRIVER' && (
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            {(['ALL', 'ACTIVE', 'ONBOARDING', 'INACTIVE'] as const).map((key) => {
              const on = statusFilter === key
              const label = key === 'ALL' ? 'All' : DRIVER_STATUS_LABELS[key]
              return (
                <button key={key} onClick={() => setStatusFilter(key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px', borderRadius: 8,
                    border: `1px solid ${on ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
                    background: on ? 'var(--tms-primary-tint)' : 'var(--tms-card)',
                    color: on ? 'var(--tms-primary)' : 'var(--tms-text-2)',
                    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                  {label}
                  <span style={{ fontSize: 11.5, color: 'var(--tms-muted)', fontWeight: 500 }}>{statusCounts[key]}</span>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'DRIVER' && <div style={{ marginTop: 16 }}><IvanPhones /></div>}

        {hub.loading && <div style={{ color: 'var(--tms-muted)', fontSize: 12.5, padding: '10px 2px' }}>Loading documents…</div>}
      </div>

      {openEntity && (
        <EntityFilePanel
          entity={openEntity}
          hub={hub}
          onClose={() => setOpenId(null)}
          onEditDriver={(d) => {
            // Close the file panel first. Both it and the Sheet are z-50 with their own
            // backdrops, so opening the editor on top of it stacked two drawers over
            // each other — which is what read as broken padding. One drawer at a time,
            // exactly like editing from the Fleet page.
            setReturnToDriverId(openId)
            setOpenId(null)
            setDriverEdit({ open: true, driver: d })
          }}
          canSeePrivate={isAdmin}
        />
      )}
      {privateDocsOpen && <PrivateDocsModal onClose={() => setPrivateDocsOpen(false)} />}
      {inviteOpen && <InviteDriverModal onClose={() => setInviteOpen(false)} />}
      <DriverDrawer
        open={driverEdit.open}
        driver={driverEdit.driver}
        onClose={() => {
          setDriverEdit({ open: false, driver: null })
          if (returnToDriverId) { setOpenId(returnToDriverId); setReturnToDriverId(null) }
        }}
      />
    </TmsScrollPage>
  )
}
