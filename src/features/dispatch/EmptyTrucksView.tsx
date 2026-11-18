/**
 * Dispatch > Empty trucks: where Ivan's own trucks go empty, from the schedule (Ryne 2026-11-18).
 *
 * A ranked list beside a US map. Each row is one truck going empty: who, where, when, what is
 * booked next, how long it sits, and the open loads nearby that could fill the gap, with an
 * Assign button that opens the usual Book Ivan Cartage dialog (nothing is assigned without a
 * click on its Book button). All the arithmetic is in emptyTrucks.ts.
 *
 * Money: customer rates and the dollar value of an idle truck only show to people who may see
 * money (admin, owner, Invoicing or Carrier pay), the same line the Accounting dashboard draws.
 * The daily value is set here by an admin; until it is set the dollar line says so and shows
 * no figure.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { AlertTriangle, MapPin, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { useDrivers } from '@/hooks/useDrivers'
import { useEnsureLoadRange, useLoads } from '@/hooks/useLoads'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useAppStore } from '@/store/useAppStore'
import { assignAsset, getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { chicagoDateStr } from '@/lib/date'
import type { Load } from '@/types'
import type { ShipmentLoad, TmsSettings } from '@/types/tms'
import { FleetMiniMap, type MapMarker } from '@/features/dashboard/FleetMiniMap'
import { AssignDriverDialog, type AssignDriverFields } from '@/features/shipments/components/AssignDriverDialog'
import {
  computeEmptyTrucks, toneOf, EMPTY_HORIZONS, LONG_DEADHEAD_MILES,
  type EmptyHorizon, type EmptyTone as Tone, type EmptyTruckRow, type OpenLoadMatch,
} from './emptyTrucks'

const DAY = 86_400_000
const HORIZON_KEY = 'bcat.dispatch.emptyHorizon'
const HORIZON_LABEL: Record<EmptyHorizon, string> = { 2: '48 hours', 7: '7 days', 14: '14 days' }

function readHorizon(): EmptyHorizon {
  try {
    const v = Number(localStorage.getItem(HORIZON_KEY))
    if ((EMPTY_HORIZONS as readonly number[]).includes(v)) return v as EmptyHorizon
  } catch { /* storage unavailable: fall through */ }
  return 7
}

/** A PRO that opens its shipment when it has one. */
function ProLink({ shipmentId, pro, title }: { shipmentId: string | null; pro: string; title?: string }) {
  const text = `PRO ${pro}`
  return shipmentId
    ? <Link to={`/tms/shipments/${shipmentId}/edit`} style={{ fontWeight: 700, color: 'var(--tms-primary)', fontVariantNumeric: 'tabular-nums' }} title={title ?? 'Open the shipment'} onClick={(e) => e.stopPropagation()}>{text}</Link>
    : <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{text}</span>
}

const TZ = 'America/Chicago'
const dayText = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(ms)
const clockText = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms)
const whenText = (ms: number, timeKnown: boolean) => (timeKnown ? `${dayText(ms)}, ${clockText(ms)}` : dayText(ms))
const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`
const daysText = (n: number) => `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)} day${n === 1 ? '' : 's'}`

const TONE_COLOR: Record<Tone, string> = {
  now: 'var(--tms-badge-red)',
  soon: 'var(--tms-badge-orange)',
  later: 'var(--tms-primary)',
}

function emptyHeadline(row: EmptyTruckRow, now: number): string {
  if (row.late) return `Past its appointment (${whenText(row.emptyAt, row.timeKnown)}), not marked left`
  if (row.alreadyEmpty) return `Empty since ${whenText(row.emptyAt, row.timeKnown)}`
  const hours = Math.max(0, Math.round((row.emptyAt - now) / 3_600_000))
  const away = hours < 1 ? 'within the hour' : hours < 24 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`
  return `Empty ${whenText(row.emptyAt, row.timeKnown)} (${away})`
}

function idleText(row: EmptyTruckRow, horizonEnd: number): string {
  if (row.kind === 'BACK_TO_BACK') return 'Next load follows right away'
  if (row.openEnded) return `No load booked: idle ${daysText(row.idleDays)} so far to ${dayText(horizonEnd)}`
  return `Idle ${daysText(row.idleDays)} until the next pickup`
}

function MatchLine({ match, canAssign, onAssign }: { match: OpenLoadMatch; canAssign: boolean; onAssign: () => void }) {
  const run = match.deadheadMiles
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12.5, padding: '4px 0', borderTop: '1px dashed var(--tms-border)' }}>
      <ProLink shipmentId={match.shipmentId} pro={match.pro} />
      <span style={{ color: 'var(--tms-text-2)', minWidth: 0 }}>{match.lane}</span>
      <span style={{ color: 'var(--tms-muted)' }}>picks up {whenText(match.pickupAt, match.pickupTimeKnown)}</span>
      {match.customer ? <span style={{ color: 'var(--tms-muted)' }}>{match.customer}</span> : null}
      {match.rateCents != null ? <span style={{ fontWeight: 600, color: 'var(--tms-text)' }}>{dollars(match.rateCents)}</span> : null}
      <span
        style={{ color: match.longDeadhead ? 'var(--tms-badge-orange)' : 'var(--tms-muted)', fontWeight: match.longDeadhead ? 700 : 500 }}
        title={`Empty run to the pickup: air miles from where the truck is empty times 1.15 for the road${match.approx ? '. One end is only placed to its state, so this is rough' : ''}.`}
      >
        {run == null ? 'distance unknown' : `${match.approx ? '≈ ' : 'about '}${run} mi empty${match.longDeadhead ? ` (over ${LONG_DEADHEAD_MILES})` : ''}`}
      </span>
      {canAssign ? <Button size="sm" variant="outline" className="h-6 px-2 text-xs ml-auto" onClick={onAssign}>Assign</Button> : null}
    </div>
  )
}

export function EmptyTrucksView() {
  const { drivers } = useDrivers()
  const { loads } = useLoads()
  const equipment = useAppStore((s) => s.equipment)
  const { isAdmin, isOwner, hasPageAccess } = useAuth()
  const isMobile = useIsMobile()
  const canSeeMoney = isAdmin || isOwner || hasPageAccess('invoicing') || hasPageAccess('carrierPay')
  const canSetValue = isAdmin || isOwner
  const canAssign = isAdmin || isOwner || hasPageAccess('tms') || hasPageAccess('dispatch')

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t) }, [])
  const [horizon, setHorizon] = useState<EmptyHorizon>(readHorizon)
  const chooseHorizon = (h: EmptyHorizon) => { setHorizon(h); try { localStorage.setItem(HORIZON_KEY, String(h)) } catch { /* fine without */ } }
  const [showBackToBack, setShowBackToBack] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  // The window of loads this reads: a few days back (just delivered) to past the window (open pickups).
  const ready = useEnsureLoadRange(chicagoDateStr(new Date(now - 5 * DAY)), chicagoDateStr(new Date(now + (horizon + 4) * DAY)))

  const [settings, setSettings] = useState<TmsSettings | null>(null)
  useEffect(() => {
    if (!canSeeMoney) return
    let alive = true
    getTmsSettings().then((s) => { if (alive) setSettings(s) }).catch(() => undefined)
    return () => { alive = false }
  }, [canSeeMoney])
  const dailyValueCents = settings?.emptyTruckDailyValueCents ?? null

  const result = useMemo(
    () => computeEmptyTrucks({ drivers, loads, equipment, now, horizonDays: horizon, dailyValueCents, canSeeMoney }),
    [drivers, loads, equipment, now, horizon, dailyValueCents, canSeeMoney],
  )
  const rows = useMemo(() => (showBackToBack ? result.rows : result.rows.filter((r) => r.kind === 'IDLE')), [result.rows, showBackToBack])
  const backToBackCount = result.rows.length - result.rows.filter((r) => r.kind === 'IDLE').length

  const markers: MapMarker[] = useMemo(() => rows
    .filter((r) => r.point.lat != null && r.point.lng != null)
    .map((r) => ({
      id: r.key, lat: r.point.lat as number, lon: r.point.lng as number, tone: toneOf(r, now), approx: r.point.approx,
      label: `${r.driverName}${r.truck ? ` · truck ${r.truck}` : ''} · ${r.point.place ?? 'unknown place'} · ${whenText(r.emptyAt, r.timeKnown)}`,
    })), [rows, now])

  // The daily value, typed in dollars by an admin.
  // null = not edited: the box shows the saved value.
  const [valueEdit, setValueEdit] = useState<string | null>(null)
  const valueDraft = valueEdit ?? (dailyValueCents != null ? String(Math.round(dailyValueCents / 100)) : '')
  const [savingValue, setSavingValue] = useState(false)
  const saveValue = async (clear = false) => {
    const dollarsTyped = clear ? null : Number(valueDraft.replace(/[$,\s]/g, ''))
    if (!clear && (!Number.isFinite(dollarsTyped) || (dollarsTyped as number) < 0)) { toast.error('Type the daily value in dollars, like 450.'); return }
    setSavingValue(true)
    try {
      const next = await saveTmsSettings({ emptyTruckDailyValueCents: clear || dollarsTyped === 0 ? null : Math.round((dollarsTyped as number) * 100) }, settings?.updatedAt ?? undefined)
      setSettings(next)
      setValueEdit(null)
      toast.success(clear ? 'Daily value cleared' : 'Daily value saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the daily value')
    } finally {
      setSavingValue(false)
    }
  }

  // Assign: the usual Book Ivan Cartage dialog, opened with the driver already picked. Nothing is booked until Book is clicked.
  const [assigning, setAssigning] = useState<{ load: Load; driverId: string } | null>(null)
  const trucks = useMemo(() => equipment.filter((e) => e.type === 'truck'), [equipment])
  const trailers = useMemo(() => equipment.filter((e) => e.type === 'trailer'), [equipment])
  const confirmAssign = async (input: AssignDriverFields) => {
    if (!assigning) return
    await assignAsset({
      loadId: assigning.load.id,
      ...(assigning.load.updatedAt ? { expectedUpdatedAt: assigning.load.updatedAt } : {}),
      driverId: input.driverId,
      truckId: input.truckId ?? null,
      truckNumber: input.truckNumber ?? null,
      trailerId: input.trailerId ?? null,
      trailerNumber: input.trailerNumber ?? null,
      flattenSplit: input.flattenSplit,
      payOverrideReason: input.payOverrideReason ?? null,
    })
    toast.success('Driver booked on the load')
  }
  const openAssign = (match: OpenLoadMatch, driverId: string) => {
    const load = loads.find((l) => l.id === match.loadId)
    if (!load) { toast.error('That load is not loaded yet. Refresh and try again.'); return }
    setAssigning({ load, driverId })
  }

  const padX = isMobile ? 12 : 20
  const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'baseline', gap: 5, padding: '4px 10px', border: '1px solid var(--tms-border)', borderRadius: 8, background: 'var(--tms-card)', fontSize: 12, color: 'var(--tms-muted)' }
  const chipValue: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }

  return (
    <div data-testid="empty-trucks" style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--tms-bg)' }}>
      <div style={{ padding: `12px ${padX}px`, borderBottom: '1px solid var(--tms-border)', background: 'var(--tms-card)', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--tms-text)', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Truck className="size-4" /> Empty trucks</div>
          <div role="group" aria-label="Window" style={{ display: 'inline-flex', gap: 2, padding: 2, border: '1px solid var(--tms-border)', borderRadius: 8 }}>
            {EMPTY_HORIZONS.map((h) => (
              <button key={h} type="button" onClick={() => chooseHorizon(h)} aria-pressed={horizon === h}
                style={{ fontSize: 12, padding: '3px 9px', borderRadius: 6, border: 'none', cursor: 'pointer', background: horizon === h ? 'var(--tms-surface-hover)' : 'transparent', color: horizon === h ? 'var(--tms-text)' : 'var(--tms-muted)', fontWeight: horizon === h ? 700 : 500 }}>
                {HORIZON_LABEL[h]}
              </button>
            ))}
          </div>
          <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12, color: 'var(--tms-muted)' }}>
            <input type="checkbox" checked={showBackToBack} onChange={(e) => setShowBackToBack(e.target.checked)} />
            Show back-to-back{backToBackCount ? ` (${backToBackCount})` : ''}
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={chip}><span style={chipValue}>{result.summary.trucks}</span> truck{result.summary.trucks === 1 ? '' : 's'} going empty</span>
          <span style={chip}><span style={chipValue}>{result.summary.idleTruckDays}</span> idle truck-days</span>
          {canSeeMoney ? (
            result.summary.valueCents != null
              ? <span style={chip} title="Idle days times the daily value below, through the end of the window"><span style={chipValue}>{dollars(result.summary.valueCents)}</span> sitting idle</span>
              : <span style={chip}>{canSetValue ? 'Set a daily value to see dollars' : 'No daily value set yet'}</span>
          ) : null}
          {canSetValue ? (
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, color: 'var(--tms-muted)' }}>
              Daily value per idle truck $
              <input aria-label="Daily value per idle truck, in dollars" inputMode="decimal" value={valueDraft} onChange={(e) => setValueEdit(e.target.value)} placeholder="e.g. 450"
                style={{ width: 80, height: 26, padding: '0 6px', fontSize: 12, border: '1px solid var(--tms-border)', borderRadius: 6, background: 'var(--tms-input-bg, var(--tms-card))', color: 'var(--tms-text)' }} />
              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={savingValue} onClick={() => void saveValue()}>Save</Button>
              {dailyValueCents != null ? <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={savingValue} onClick={() => void saveValue(true)}>Clear</Button> : null}
            </span>
          ) : null}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', gap: 16, padding: `12px ${padX}px`, flexDirection: isMobile ? 'column-reverse' : 'row', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, width: '100%', display: 'grid', gap: 10 }}>
          {!ready && rows.length === 0 ? <div style={{ color: 'var(--tms-muted)', fontSize: 13, padding: 12 }}>Loading the schedule…</div> : null}
          {ready && rows.length === 0 ? (
            <div style={{ color: 'var(--tms-muted)', fontSize: 13, padding: 16, border: '1px dashed var(--tms-border)', borderRadius: 10 }}>
              No own-fleet truck goes empty in the next {HORIZON_LABEL[horizon]} on the schedule. Trucks booked back to back are hidden unless you tick Show back-to-back.
            </div>
          ) : null}
          {rows.map((row) => {
            const tone = toneOf(row, now)
            const isSel = selected === row.key
            return (
              <div
                key={row.key}
                data-testid="empty-truck-row"
                onClick={() => setSelected(row.key)}
                style={{ border: `1px solid ${isSel ? TONE_COLOR[tone] : 'var(--tms-border)'}`, borderLeft: `4px solid ${TONE_COLOR[tone]}`, borderRadius: 10, background: 'var(--tms-card)', padding: '10px 12px', cursor: 'pointer', opacity: row.kind === 'BACK_TO_BACK' ? 0.75 : 1 }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--tms-text)' }}>{row.driverName}</span>
                  <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{row.truck ? `Truck ${row.truck}` : 'No truck on file'}{row.trailer ? ` · Trailer ${row.trailer}` : ''}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: TONE_COLOR[tone] }}>{emptyHeadline(row, now)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 3, fontSize: 13, color: 'var(--tms-text-2)' }}>
                  <MapPin className="size-3.5" aria-hidden="true" />
                  <strong>{row.point.place ?? 'Place not on the stop'}</strong>
                  {row.point.approx ? <span style={{ fontSize: 11, color: 'var(--tms-muted)' }} title="The stop has no city on file the map knows, so it is placed at the middle of its state">(state centre on the map)</span> : null}
                  <span style={{ color: 'var(--tms-muted)' }}>after</span>
                  <ProLink shipmentId={row.endLoad.shipmentId} pro={row.endLoad.pro} />
                  <span style={{ color: 'var(--tms-muted)' }}>{row.endLoad.lane}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4, fontSize: 12.5 }}>
                  <span style={{ color: row.next ? 'var(--tms-text-2)' : 'var(--tms-badge-orange)', fontWeight: row.next ? 500 : 700 }}>
                    {row.next
                      ? <>Booked next: <ProLink shipmentId={row.next.shipmentId} pro={row.next.pro} /> {row.next.place ?? ''} · picks up {whenText(row.next.startAt, row.next.timeKnown)}</>
                      : 'Nothing booked'}
                  </span>
                  <span style={{ color: 'var(--tms-muted)' }}>{idleText(row, result.horizonEnd)}</span>
                  {canSeeMoney && row.kind === 'IDLE' ? (
                    row.idleValueCents != null
                      ? <span style={{ fontWeight: 700, color: 'var(--tms-text)' }}>{dollars(row.idleValueCents)} idle</span>
                      : <span style={{ color: 'var(--tms-muted)' }}>{canSetValue ? 'Set a daily value to see $' : 'No daily value set'}</span>
                  ) : null}
                </div>
                {row.kind === 'IDLE' ? (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>Open loads near here</div>
                    {row.matches.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: 'var(--tms-muted)', padding: '4px 0' }}>None uncovered with a pickup after this truck is empty{row.next ? ' and before its next load' : ''}.</div>
                    ) : row.matches.map((m) => (
                      <MatchLine key={m.loadId} match={m} canAssign={canAssign} onAssign={() => openAssign(m, row.driverId)} />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
          {rows.some((r) => r.matches.some((m) => m.approx)) ? (
            <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', display: 'flex', gap: 5, alignItems: 'center' }}>
              <AlertTriangle className="size-3" /> Distances marked ≈ are rough: one end is only placed to its state.
            </div>
          ) : null}
          <div style={{ fontSize: 11.5, color: 'var(--tms-muted)' }}>
            Empty means after the last stop on the schedule: the time it left if it has, else its appointment. Own-fleet (Ivan) drivers only. Times are Chicago.
          </div>
        </div>
        <div style={{ width: isMobile ? '100%' : 420, flexShrink: 0, position: isMobile ? 'static' : 'sticky', top: 0, border: '1px solid var(--tms-border)', borderRadius: 10, background: 'var(--tms-card)' }}>
          <FleetMiniMap markers={markers} selectedMarkerId={selected} onMarkerClick={setSelected} />
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', fontSize: 11, color: 'var(--tms-muted)', paddingBottom: 8 }}>
            <span><span style={{ color: TONE_COLOR.now }}>●</span> empty now</span>
            <span><span style={{ color: TONE_COLOR.soon }}>●</span> within a day</span>
            <span><span style={{ color: TONE_COLOR.later }}>●</span> later</span>
          </div>
        </div>
      </div>

      {assigning ? (
        <AssignDriverDialog
          load={assigning.load as unknown as ShipmentLoad}
          activeLeg={null}
          drivers={drivers}
          trucks={trucks}
          trailers={trailers}
          isAdmin={isAdmin || isOwner}
          busy={false}
          initialDriverId={assigning.driverId}
          onClose={() => setAssigning(null)}
          onConfirm={confirmAssign}
        />
      ) : null}
    </div>
  )
}
