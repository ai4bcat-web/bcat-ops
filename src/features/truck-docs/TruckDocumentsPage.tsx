/**
 * Asset Documents — trucks and trailers.
 *
 * Deliberately the SAME interface as the Files hub: a scannable row per asset, columns
 * for every document that carries an expiration date, and a click-through drawer with
 * upload cards. It renders the very same EntityFilePanel the Files page uses, against
 * the same ComplianceDocument records and the same TRUCK_DOC_SPECS catalog — so a file
 * uploaded on either page appears on the other immediately, and the two can never show
 * a different status for the same truck.
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Search, Truck as TruckIcon, Container, FileStack } from 'lucide-react'
import { TmsAlert } from '@/features/tms/kit/TmsAlert'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import type { TmsTone } from '@/features/tms/kit/TmsBadge'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useFileHub } from '@/hooks/useFileHub'
import { formatVin } from '@/lib/utils'
import { useDriverTypes } from '@/hooks/useDriverTypes'
import { TRUCK_DOC_SPECS, specsForAssetType, evaluateTruckDoc, type DocState } from '@/lib/truckDocs'
import { slotsForAsset, readyScore, truckSlotState, visibleSlots, type ReadyScore } from '@/lib/fileHub'
import { EntityFilePanel } from '@/features/files/EntityFilePanel'
import { downloadEntityPacket, packetToast, driverForTruck, type FileEntity } from '@/features/files/entityPacket'
import type { Equipment } from '@/types/equipment'

type Tab = 'truck' | 'trailer'

/** Only documents with a real expiration get their own column. Photos never do. */
const datedSpecsFor = (type: 'truck' | 'trailer') => specsForAssetType(type).filter((s) => !s.photo)

const STATUS_STYLE: Record<DocState, { tone: TmsTone; label: string }> = {
  VALID:         { tone: 'green', label: 'Valid' },
  EXPIRING_SOON: { tone: 'orange', label: 'Soon' },
  EXPIRED:       { tone: 'red', label: 'Expired' },
  MISSING:       { tone: 'gray', label: 'Missing' },
  WAIVED:        { tone: 'gray', label: 'N/A' },
}

const TH: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase',
  letterSpacing: '0.04em', padding: '8px 10px', textAlign: 'left', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--tms-text)', padding: '9px 10px', textAlign: 'left' }

const shortDate = (d?: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', timeZone: 'UTC' }) : '—'

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

/** One document's state + date, as a compact pill inside a column. */
function DocCell({ asset, specKey, hub }: { asset: Equipment; specKey: string; hub: ReturnType<typeof useFileHub> }) {
  const spec = TRUCK_DOC_SPECS.find((s) => s.key === specKey)!
  const doc = hub.docFor('TRUCK', asset.id, specKey)
  const { state, expiration } = evaluateTruckDoc(asset, spec, doc)
  const style = STATUS_STYLE[state]
  return (
    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <TmsBadge tone={style.tone}>{style.label}</TmsBadge>
        <span style={{ fontSize: 12, color: 'var(--tms-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {expiration ? shortDate(expiration) : ''}
        </span>
      </span>
    </td>
  )
}

export function TruckDocumentsPage() {
  const { fleetGroupLabel } = useDriverTypes()
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)
  const storeLoading = useAppStore((s) => s.isLoading)
  const hub = useFileHub()
  const { isAdmin } = useAuth()

  const [tab, setTab] = useState<Tab>('truck')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [packetBusyId, setPacketBusyId] = useState<string | null>(null)

  // Columns follow the tab: trailers have no IFTA/IRP-style truck-only rows.
  const datedSpecs = useMemo(() => datedSpecsFor(tab), [tab])

  const assets = useMemo(
    () => equipment.filter((e) => e.type === tab && e.active !== false)
      .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [equipment, tab],
  )

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!q) return assets
    return assets.filter((a) =>
      [a.unitNumber, a.vin, a.plate, a.make, a.model, a.nickname].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [assets, q])

  const scoreFor = (asset: Equipment): ReadyScore =>
    readyScore(visibleSlots(slotsForAsset(asset.type, asset.fleetGroup), isAdmin), (key) => truckSlotState(asset, key, hub.docFor('TRUCK', asset.id, key)))

  const downloadPacket = async (asset: Equipment) => {
    setPacketBusyId(asset.id)
    try {
      const outcome = await downloadEntityPacket({
        entity: { kind: 'TRUCK', truck: asset }, hub, drivers, equipment,
        todayIso: new Date().toISOString().slice(0, 10), canSeePrivate: isAdmin,
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
    const a = equipment.find((e) => e.id === openId)
    return a ? { kind: 'TRUCK', truck: a } : null
  }, [openId, equipment])

  const counts = useMemo(() => ({
    truck:   equipment.filter((e) => e.type === 'truck' && e.active !== false).length,
    trailer: equipment.filter((e) => e.type === 'trailer' && e.active !== false).length,
  }), [equipment])

  const tabBtn = (t: Tab, label: string, Icon: typeof TruckIcon) => (
    <button onClick={() => { setTab(t); setOpenId(null) }}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 8,
        border: `1px solid ${tab === t ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
        background: tab === t ? 'var(--tms-primary-tint)' : 'var(--tms-card)',
        color: tab === t ? 'var(--tms-primary)' : 'var(--tms-text-2)',
        fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
      }}>
      <Icon size={14} /> {label}
      <span style={{ fontSize: 11.5, color: 'var(--tms-muted)', fontWeight: 500 }}>{counts[t]}</span>
    </button>
  )

  return (
    <TmsScrollPage
      title="Asset Documents"
      subtitle="Insurance, IFTA, registration, DOT inspection and truck photos. Click any row to open its file and upload. Same records as the Files page — upload once and it shows in both."
      stickyHead
      toolbar={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {tabBtn('truck', 'Trucks', TruckIcon)}
          {tabBtn('trailer', 'Trailers', Container)}
          <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--tms-muted)' }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search unit #, VIN, plate, make"
              style={{
                height: 32, width: '100%', borderRadius: 8, border: '1px solid var(--tms-border)',
                padding: '0 10px 0 30px', fontSize: 13, background: 'var(--tms-card)', color: 'var(--tms-text)',
                boxSizing: 'border-box', fontFamily: 'inherit',
              }} />
          </div>
        </div>
      }
    >
      <div style={{ marginTop: 4 }}>
        {hub.error && (
          <TmsAlert tone="red">Couldn't load documents: {hub.error}</TmsAlert>
        )}

        <div style={{ borderRadius: 12, border: '1px solid var(--tms-border)', overflow: 'auto', background: 'var(--tms-card)', boxShadow: 'var(--tms-shadow)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
                <th style={TH}>Unit</th>
                <th style={TH}>VIN</th>
                {tab === 'truck' && <th style={TH}>Driver</th>}
                {/* One column per document that carries an expiration date */}
                {datedSpecs.map((s) => <th key={s.key} style={TH}>{s.label}</th>)}
                <th style={{ ...TH, textAlign: 'right' }}>On file</th>
                <th style={{ ...TH, width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={datedSpecs.length + (tab === 'truck' ? 5 : 4)} style={{ ...TD, textAlign: 'center', color: 'var(--tms-muted)', padding: 24 }}>
                    {assets.length === 0
                      ? (storeLoading ? 'Loading…' : `No active ${tab === 'truck' ? 'trucks' : 'trailers'}.`)
                      : `Nothing matches "${query}".`}
                  </td>
                </tr>
              )}

              {shown.map((a) => {
                const driver = driverForTruck(a, drivers)
                return (
                  <tr key={a.id} onClick={() => setOpenId(a.id)}
                    style={{ borderBottom: '1px solid var(--tms-border)', cursor: 'pointer', background: openId === a.id ? 'var(--tms-bg)' : undefined }}>
                    <td style={{ ...TD, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      #{a.unitNumber}
                      {a.fleetGroup && (
                        <span style={{ fontSize: 10.5, color: 'var(--tms-muted)', marginLeft: 6 }}>{fleetGroupLabel(a.fleetGroup)}</span>
                      )}
                    </td>
                    <td style={{ ...TD, color: 'var(--tms-text-2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{formatVin(a.vin) || '—'}</td>
                    {tab === 'truck' && <td style={{ ...TD, color: 'var(--tms-text-2)', whiteSpace: 'nowrap' }}>{driver?.name ?? '—'}</td>}
                    {datedSpecs.map((s) => <DocCell key={s.key} asset={a} specKey={s.key} hub={hub} />)}
                    <td style={{ ...TD, textAlign: 'right' }}><ReadyDots score={scoreFor(a)} /></td>
                    <td style={{ ...TD, textAlign: 'right', padding: '6px 10px' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadPacket(a) }}
                        disabled={packetBusyId === a.id}
                        title="Download every document for this asset as one PDF"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 10px',
                          borderRadius: 7, border: '1px solid var(--tms-border)', background: 'var(--tms-card)',
                          color: 'var(--tms-primary)', fontSize: 12, fontWeight: 600,
                          cursor: packetBusyId === a.id ? 'wait' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                        }}>
                        <FileStack size={13} /> {packetBusyId === a.id ? 'Building…' : 'Download full PDF'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {hub.loading && <div style={{ color: 'var(--tms-muted)', fontSize: 12.5, padding: '10px 2px' }}>Loading documents…</div>}
      </div>

      {openEntity && <EntityFilePanel entity={openEntity} hub={hub} onClose={() => setOpenId(null)} canSeePrivate={isAdmin} />}
    </TmsScrollPage>
  )
}
