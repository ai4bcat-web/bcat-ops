import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { FolderOpen, Search, Users, Truck as TruckIcon, FileStack, UserPlus, EyeOff } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useFileHub } from '@/hooks/useFileHub'
import { Avatar } from '@/components/ui/avatar'
import { getColor } from '@/lib/driverColors'
import { formatPhone, formatVin } from '@/lib/utils'
import {
  slotsForDriver, slotsForAsset, readyScore, slotState, truckSlotState, driverExpiry, visibleSlots,
  type ReadyScore, type SlotState, type ExpiryInfo,
} from '@/lib/fileHub'
import { FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import { EntityFilePanel } from './EntityFilePanel'
import { DriverDrawer } from '@/features/drivers/DriverDrawer'
import { PrivateDocsModal } from './PrivateDocsModal'
import { useComplianceSettings } from '@/hooks/useComplianceSettings'
import { downloadEntityPacket, packetToast, driverForTruck, type FileEntity } from './entityPacket'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'

type Tab = 'DRIVER' | 'TRUCK'

const getInitials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'

const TH: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase',
  letterSpacing: '0.04em', padding: '8px 10px', textAlign: 'left', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 10px', textAlign: 'left' }

/** ●●●○○ — filled per required slot on file, amber when something needs attention. */
function ReadyDots({ score }: { score: ReadyScore }) {
  const color = score.missing > 0 ? 'var(--ds-t3)' : score.attention > 0 ? '#b45309' : '#15803d'
  return (
    <span title={`${score.onFile} of ${score.required} on file${score.attention ? ` · ${score.attention} need attention` : ''}`}
      style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {Array.from({ length: score.required }, (_, i) => (
        <span key={i} style={{
          width: 7, height: 7, borderRadius: '50%',
          background: i < score.onFile ? color : 'transparent',
          border: i < score.onFile ? 'none' : '1px solid var(--ds-border)',
        }} />
      ))}
      <span style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>
        {score.onFile}/{score.required}
      </span>
    </span>
  )
}

const EXPIRY_STYLE: Record<SlotState, { bg: string; fg: string }> = {
  VALID:         { bg: '#f0fdf4', fg: '#15803d' },
  EXPIRING_SOON: { bg: '#fffbeb', fg: '#b45309' },
  EXPIRED:       { bg: '#fef2f2', fg: '#b91c1c' },
  MISSING:       { bg: 'var(--ds-bg)', fg: 'var(--ds-t3)' },
  WAIVED:        { bg: 'var(--ds-bg)', fg: 'var(--ds-t3)' },
  PENDING_REVIEW:{ bg: '#fffbeb', fg: '#b45309' },
}

const shortDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', timeZone: 'UTC' })

/** A driver's CDL / med-card expiry, colour-coded, flagging a record-vs-document mismatch. */
function ExpiryCell({ info }: { info: ExpiryInfo }) {
  const style = EXPIRY_STYLE[info.state]
  if (!info.date) {
    return <td style={{ ...TD, color: 'var(--ds-t3)' }}>—</td>
  }
  return (
    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: style.fg, background: style.bg, padding: '2px 7px', borderRadius: 999, fontVariantNumeric: 'tabular-nums' }}>
        {shortDate(info.date)}
      </span>
      {info.conflict && (
        <span
          title={`The driver record says ${info.recordDate} but the uploaded document says ${info.documentDate}. Showing the driver record — fix whichever is wrong.`}
          style={{ marginLeft: 5, fontSize: 11, color: '#b45309', cursor: 'help' }}>⚠</span>
      )}
    </td>
  )
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

  const [tab, setTab] = useState<Tab>('TRUCK')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [packetBusyId, setPacketBusyId] = useState<string | null>(null)
  // The full driver editor, moved here from the retired Drivers page — the only place
  // that can create a driver or edit phone/CDL/colour/photo/classification.
  const [driverEdit, setDriverEdit] = useState<{ open: boolean; driver: Driver | null }>({ open: false, driver: null })

  const trucks = useMemo(
    () => equipment.filter((e) => e.type === 'truck' && e.active !== false)
      .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [equipment],
  )
  const trailers = useMemo(() => equipment.filter((e) => e.type === 'trailer'), [equipment])

  const activeDrivers = useMemo(
    () => drivers.filter((d) => d.active !== false && d.type !== 'broker')
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
  const shownDrivers = useMemo(() => {
    if (!q) return activeDrivers
    return activeDrivers.filter((d) => {
      const truck = trucks.find((t) => t.id === d.assignedTruckId)
      const fleet = d.fleetGroup ? FLEET_GROUP_LABELS[d.fleetGroup] : ''
      return [d.name, d.phone, d.cdl, truck?.unitNumber, fleet].some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [activeDrivers, trucks, q])

  const shownTrucks = useMemo(() => {
    if (!q) return trucks
    return trucks.filter((t) =>
      [t.unitNumber, t.vin, t.plate, t.make, t.model, t.nickname].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [trucks, q])

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
        border: `1px solid ${tab === t ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
        background: tab === t ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)',
        color: tab === t ? 'var(--ds-blue)' : 'var(--ds-t2)',
        fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
      }}>
      <Icon size={14} /> {label}
      <span style={{ fontSize: 11.5, color: 'var(--ds-t3)', fontWeight: 500 }}>{count}</span>
    </button>
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ padding: '20px 32px 12px' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FolderOpen size={20} /> Files
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
            Every document and detail on file for each driver and truck — view, download or upload what's missing.
            Shares one store with Compliance, Onboarding and Asset Documents, so nothing is uploaded twice.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            {tabBtn('TRUCK', 'Trucks', TruckIcon, trucks.length)}
            {tabBtn('DRIVER', 'Drivers', Users, activeDrivers.length)}
            {isAdmin && (
              <button onClick={() => setPrivateDocsOpen(true)} title="Choose which documents are hidden from everyone else"
                style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                <EyeOff size={14} /> Private docs
              </button>
            )}
            {tab === 'DRIVER' && (
              <button onClick={() => setDriverEdit({ open: true, driver: null })}
                title="Add a new driver"
                style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                <UserPlus size={14} /> Add driver
              </button>
            )}
            <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)' }} />
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'DRIVER' ? 'Search name, phone, CDL, truck #' : 'Search unit #, VIN, plate, make'}
                style={{
                  height: 32, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)',
                  padding: '0 10px 0 30px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)',
                  boxSizing: 'border-box', fontFamily: 'inherit',
                }} />
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 32px 40px', maxWidth: 1100, margin: '0 auto' }}>
        {storeError && (
          <div style={{ color: '#dc2626', fontSize: 13, padding: 12, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', marginBottom: 14 }}>
            Couldn't load drivers and loads: {storeError}
          </div>
        )}
        {hub.error && (
          <div style={{ color: '#dc2626', fontSize: 13, padding: 12, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', marginBottom: 14 }}>
            Couldn't load documents: {hub.error}
          </div>
        )}

        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                {tab === 'DRIVER' ? (
                  <>
                    <th style={TH}>Driver</th><th style={TH}>Type</th><th style={TH}>Phone</th><th style={TH}>CDL</th>
                    <th style={TH}>CDL expires</th><th style={TH}>Med card expires</th>
                    <th style={TH}>Truck</th><th style={TH}>Trailer</th><th style={{ ...TH, textAlign: 'right' }}>On file</th>
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
                <tr><td colSpan={9} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: 24 }}>
                  {activeDrivers.length === 0
                    ? (storeLoading ? 'Loading drivers…' : 'No drivers loaded. If the roster is empty everywhere, the drivers query failed — check the console.')
                    : `No drivers match "${query}".`}
                </td></tr>
              )}
              {tab === 'TRUCK' && shownTrucks.length === 0 && (
                <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: 24 }}>
                  {trucks.length === 0
                    ? (storeLoading ? 'Loading trucks…' : 'No active trucks.')
                    : `No trucks match "${query}".`}
                </td></tr>
              )}

              {tab === 'DRIVER' && shownDrivers.map((d: Driver) => {
                const truck = trucks.find((t) => t.id === d.assignedTruckId)
                const trailer = trailers.find((t) => t.id === d.assignedTrailerId)
                return (
                  <tr key={d.id} onClick={() => setOpenId(d.id)}
                    style={{ borderBottom: '1px solid var(--ds-border)', cursor: 'pointer', background: openId === d.id ? 'var(--ds-bg)' : undefined }}>
                    <td style={TD}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Avatar src={d.photoUrl} initials={getInitials(d.name)} size="xs" style={{ background: getColor(d.colorKey).avatarBg, color: '#fff' }} />
                        <b style={{ fontWeight: 600 }}>{d.name}</b>
                      </span>
                    </td>
                    <td style={{ ...TD }}>
                      {d.fleetGroup
                        ? <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t2)', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', padding: '2px 7px', borderRadius: 999, whiteSpace: 'nowrap' }}>{FLEET_GROUP_LABELS[d.fleetGroup]}</span>
                        : <span style={{ color: 'var(--ds-t3)', fontSize: 12 }}>Unclassified</span>}
                    </td>
                    <td style={{ ...TD, color: 'var(--ds-t2)' }}>{d.phone ? formatPhone(d.phone) : '—'}</td>
                    <td style={{ ...TD, color: 'var(--ds-t2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{d.cdl || '—'}</td>
                    <ExpiryCell info={driverExpiry(d.cdlExpiration, hub.docFor('DRIVER', d.id, 'cdl_copy'))} />
                    <ExpiryCell info={driverExpiry(d.medCardExpiration, hub.docFor('DRIVER', d.id, 'medical_card'))} />
                    <td style={{ ...TD, color: 'var(--ds-t2)' }}>{truck?.unitNumber ?? '—'}</td>
                    <td style={{ ...TD, color: trailer ? 'var(--ds-t2)' : 'var(--ds-t3)' }}>{trailer?.unitNumber ?? 'TBD'}</td>
                    <td style={{ ...TD, textAlign: 'right' }}><ReadyDots score={scoreFor('DRIVER', d.id)} /></td>
                  </tr>
                )
              })}

              {tab === 'TRUCK' && shownTrucks.map((t: Equipment) => {
                const driver = driverForTruck(t, drivers)
                return (
                  <tr key={t.id} onClick={() => setOpenId(t.id)}
                    style={{ borderBottom: '1px solid var(--ds-border)', cursor: 'pointer', background: openId === t.id ? 'var(--ds-bg)' : undefined }}>
                    <td style={{ ...TD, fontWeight: 600 }}>{t.unitNumber}</td>
                    <td style={{ ...TD, color: 'var(--ds-t2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{formatVin(t.vin) || '—'}</td>
                    <td style={{ ...TD, color: 'var(--ds-t2)' }}>{t.plate || '—'}</td>
                    <td style={{ ...TD, color: 'var(--ds-t2)' }}>{[t.make, t.model].filter(Boolean).join(' ') || '—'}</td>
                    <td style={{ ...TD, color: 'var(--ds-t2)' }}>{driver?.name ?? '—'}</td>
                    <td style={{ ...TD, textAlign: 'right' }}><ReadyDots score={scoreFor('TRUCK', t.id)} /></td>
                    <td style={{ ...TD, textAlign: 'right', padding: '6px 10px' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadPacket({ kind: 'TRUCK', truck: t }, t.id) }}
                        disabled={packetBusyId === t.id}
                        title="Download every document for this truck as one PDF"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 10px',
                          borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
                          color: 'var(--ds-blue)', fontSize: 12, fontWeight: 600,
                          cursor: packetBusyId === t.id ? 'wait' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                        }}>
                        <FileStack size={13} /> {packetBusyId === t.id ? 'Building…' : 'Download full PDF'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {hub.loading && <div style={{ color: 'var(--ds-t3)', fontSize: 12.5, padding: '10px 2px' }}>Loading documents…</div>}
      </div>

      {openEntity && (
        <EntityFilePanel
          entity={openEntity}
          hub={hub}
          onClose={() => setOpenId(null)}
          onEditDriver={(d) => setDriverEdit({ open: true, driver: d })}
          canSeePrivate={isAdmin}
        />
      )}
      {privateDocsOpen && <PrivateDocsModal onClose={() => setPrivateDocsOpen(false)} />}
      <DriverDrawer open={driverEdit.open} driver={driverEdit.driver} onClose={() => setDriverEdit({ open: false, driver: null })} />
    </div>
  )
}
