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
import { FileText, Search, Truck as TruckIcon, Container, FileStack } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useFileHub } from '@/hooks/useFileHub'
import { formatVin } from '@/lib/utils'
import { FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import { TRUCK_DOC_SPECS, specsForAssetType, evaluateTruckDoc, type DocState } from '@/lib/truckDocs'
import { slotsForAsset, readyScore, truckSlotState, visibleSlots, type ReadyScore } from '@/lib/fileHub'
import { EntityFilePanel } from '@/features/files/EntityFilePanel'
import { downloadEntityPacket, packetToast, driverForTruck, type FileEntity } from '@/features/files/entityPacket'
import type { Equipment } from '@/types/equipment'

type Tab = 'truck' | 'trailer'

/** Only documents with a real expiration get their own column. Photos never do. */
const datedSpecsFor = (type: 'truck' | 'trailer') => specsForAssetType(type).filter((s) => !s.photo)

const STATUS_STYLE: Record<DocState, { bg: string; fg: string; label: string }> = {
  VALID:         { bg: '#f0fdf4', fg: '#15803d', label: 'Valid' },
  EXPIRING_SOON: { bg: '#fffbeb', fg: '#b45309', label: 'Soon' },
  EXPIRED:       { bg: '#fef2f2', fg: '#b91c1c', label: 'Expired' },
  MISSING:       { bg: 'var(--ds-bg)', fg: 'var(--ds-t3)', label: 'Missing' },
  WAIVED:        { bg: 'var(--ds-bg)', fg: 'var(--ds-t3)', label: 'N/A' },
}

const TH: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase',
  letterSpacing: '0.04em', padding: '8px 10px', textAlign: 'left', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 10px', textAlign: 'left' }

const shortDate = (d?: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', timeZone: 'UTC' }) : '—'

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

/** One document's state + date, as a compact pill inside a column. */
function DocCell({ asset, specKey, hub }: { asset: Equipment; specKey: string; hub: ReturnType<typeof useFileHub> }) {
  const spec = TRUCK_DOC_SPECS.find((s) => s.key === specKey)!
  const doc = hub.docFor('TRUCK', asset.id, specKey)
  const { state, expiration } = evaluateTruckDoc(asset, spec, doc)
  const style = STATUS_STYLE[state]
  return (
    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: style.fg, background: style.bg, padding: '2px 7px', borderRadius: 999 }}>
          {style.label}
        </span>
        <span style={{ fontSize: 12, color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums' }}>
          {expiration ? shortDate(expiration) : ''}
        </span>
      </span>
    </td>
  )
}

export function TruckDocumentsPage() {
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
        border: `1px solid ${tab === t ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
        background: tab === t ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)',
        color: tab === t ? 'var(--ds-blue)' : 'var(--ds-t2)',
        fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
      }}>
      <Icon size={14} /> {label}
      <span style={{ fontSize: 11.5, color: 'var(--ds-t3)', fontWeight: 500 }}>{counts[t]}</span>
    </button>
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ padding: '20px 32px 12px' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={20} /> Asset Documents
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
            Insurance, IFTA, registration, DOT inspection and truck photos. Click any row to open its file and upload.
            Same records as the Files page — upload once and it shows in both.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            {tabBtn('truck', 'Trucks', TruckIcon)}
            {tabBtn('trailer', 'Trailers', Container)}
            <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)' }} />
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search unit #, VIN, plate, make"
                style={{
                  height: 32, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)',
                  padding: '0 10px 0 30px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)',
                  boxSizing: 'border-box', fontFamily: 'inherit',
                }} />
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 32px 40px' }}>
        {hub.error && (
          <div style={{ color: '#dc2626', fontSize: 13, padding: 12, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', marginBottom: 14 }}>
            Couldn't load documents: {hub.error}
          </div>
        )}

        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'auto', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
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
                  <td colSpan={datedSpecs.length + (tab === 'truck' ? 5 : 4)} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: 24 }}>
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
                    style={{ borderBottom: '1px solid var(--ds-border)', cursor: 'pointer', background: openId === a.id ? 'var(--ds-bg)' : undefined }}>
                    <td style={{ ...TD, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      #{a.unitNumber}
                      {a.fleetGroup && (
                        <span style={{ fontSize: 10.5, color: 'var(--ds-t3)', marginLeft: 6 }}>{FLEET_GROUP_LABELS[a.fleetGroup]}</span>
                      )}
                    </td>
                    <td style={{ ...TD, color: 'var(--ds-t2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{formatVin(a.vin) || '—'}</td>
                    {tab === 'truck' && <td style={{ ...TD, color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>{driver?.name ?? '—'}</td>}
                    {datedSpecs.map((s) => <DocCell key={s.key} asset={a} specKey={s.key} hub={hub} />)}
                    <td style={{ ...TD, textAlign: 'right' }}><ReadyDots score={scoreFor(a)} /></td>
                    <td style={{ ...TD, textAlign: 'right', padding: '6px 10px' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadPacket(a) }}
                        disabled={packetBusyId === a.id}
                        title="Download every document for this asset as one PDF"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 10px',
                          borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
                          color: 'var(--ds-blue)', fontSize: 12, fontWeight: 600,
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

        {hub.loading && <div style={{ color: 'var(--ds-t3)', fontSize: 12.5, padding: '10px 2px' }}>Loading documents…</div>}
      </div>

      {openEntity && <EntityFilePanel entity={openEntity} hub={hub} onClose={() => setOpenId(null)} canSeePrivate={isAdmin} />}
    </div>
  )
}
