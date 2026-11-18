/**
 * Dispatch > Empty trucks: where Ivan's own trucks go empty, from the schedule (Ryne 2026-11-18).
 *
 * The toolbar (window, back-to-back, the admin's daily value) and the data live here; what is
 * drawn (the numbers strip, the map with its numbered cards, the ranked list) is
 * EmptyTrucksBoard. Each truck is one row: who, where, when, what is booked next, how long it
 * sits, and the open loads nearby that could fill the gap, with an Assign button that opens
 * the usual Book Ivan Cartage dialog (nothing is assigned without a click on its Book button).
 * All the arithmetic is in emptyTrucks.ts.
 *
 * Money: customer rates and the dollar value of an idle truck only show to people who may see
 * money (admin, owner, Invoicing or Carrier pay), the same line the Accounting dashboard draws.
 * The daily value is set here by an admin; until it is set the dollar line says so and shows
 * no figure.
 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Truck } from 'lucide-react'
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
import { AssignDriverDialog, type AssignDriverFields } from '@/features/shipments/components/AssignDriverDialog'
import { computeEmptyTrucks, EMPTY_HORIZONS, type EmptyHorizon, type OpenLoadMatch } from './emptyTrucks'
import { EmptyTrucksBoard } from './EmptyTrucksBoard'

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
        {canSetValue ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, color: 'var(--tms-muted)' }}>
              Daily value per idle truck $
              <input aria-label="Daily value per idle truck, in dollars" inputMode="decimal" value={valueDraft} onChange={(e) => setValueEdit(e.target.value)} placeholder="e.g. 450"
                style={{ width: 80, height: 26, padding: '0 6px', fontSize: 12, border: '1px solid var(--tms-border)', borderRadius: 6, background: 'var(--tms-input-bg, var(--tms-card))', color: 'var(--tms-text)' }} />
              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={savingValue} onClick={() => void saveValue()}>Save</Button>
              {dailyValueCents != null ? <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={savingValue} onClick={() => void saveValue(true)}>Clear</Button> : null}
            </span>
          </div>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `14px ${padX}px 24px` }}>
        <EmptyTrucksBoard
          result={result}
          rows={rows}
          now={now}
          ready={ready}
          horizonLabel={HORIZON_LABEL[horizon]}
          canSeeMoney={canSeeMoney}
          canSetValue={canSetValue}
          canAssign={canAssign}
          selected={selected}
          onSelect={setSelected}
          onAssign={openAssign}
        />
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
