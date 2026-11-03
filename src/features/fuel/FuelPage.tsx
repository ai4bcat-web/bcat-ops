import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, subWeeks, subMonths } from 'date-fns'
import { Fuel, Upload, Truck as TruckIcon, AlertTriangle, ShieldCheck } from 'lucide-react'
import { TmsAlert } from '@/features/tms/kit/TmsAlert'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { TmsStatRow } from '@/features/tms/kit/TmsStatRow'
import { useAppStore } from '@/store/useAppStore'
import { TruckMpgTable } from './TruckMpgTable'
import { useFuelTransactions, type FuelTransaction } from '@/hooks/useFuelTransactions'
import { useIsMobile } from '@/hooks/useIsMobile'
import { DieselPriceWidget } from '@/features/dashboard/DieselPriceWidget'
import { FuelUploadModal } from '@/features/expenses/FuelUploadModal'
import { detectFuelAnomalies } from '@/lib/fuelAnomalies'
import type { Equipment } from '@/types/equipment'

interface Agg { spend: number; gallons: number; count: number }

// Fuel = ULSD + FUEL (generic diesel) + DEF + biodiesel — same definition used across the app.
const FUEL_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])
function isFuel(t: FuelTransaction): boolean {
  if (t.itemCategory === 'FUEL') return true
  if (t.itemCategory === 'SCALE' || t.itemCategory === 'CASH_ADVANCE') return false
  return FUEL_TYPES.has((t.fuelType ?? '').toUpperCase())
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const money2 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const gal = (n: number) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)} gal`

// Drivers who buy their own fuel — matched by (lowercased) name substring, excluded
// from every fuel total on this page.
const SELF_FUEL_DRIVERS = ['roy']

type RangeKey = 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'all'
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'this-week',  label: 'This Week' },
  { key: 'last-week',  label: 'Last Week' },
  { key: 'this-month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: 'all',        label: 'All Time' },
]

const WEEK = { weekStartsOn: 0 } as const

function getRange(key: RangeKey): [Date, Date] {
  const now = new Date()
  switch (key) {
    case 'this-week':  return [startOfWeek(now, WEEK), endOfWeek(now, WEEK)]
    case 'last-week':  return [startOfWeek(subWeeks(now, 1), WEEK), endOfWeek(subWeeks(now, 1), WEEK)]
    case 'this-month': return [startOfMonth(now), endOfMonth(now)]
    case 'last-month': return [startOfMonth(subMonths(now, 1)), endOfMonth(subMonths(now, 1))]
    case 'all':        return [new Date(2000, 0, 1), now]
  }
}

function getPrevRange(key: RangeKey): [Date, Date] | null {
  const now = new Date()
  switch (key) {
    case 'this-week':  return [startOfWeek(subWeeks(now, 1), WEEK), endOfWeek(subWeeks(now, 1), WEEK)]
    case 'last-week':  return [startOfWeek(subWeeks(now, 2), WEEK), endOfWeek(subWeeks(now, 2), WEEK)]
    case 'this-month': return [startOfMonth(subMonths(now, 1)), endOfMonth(subMonths(now, 1))]
    case 'last-month': return [startOfMonth(subMonths(now, 2)), endOfMonth(subMonths(now, 2))]
    case 'all':        return null
  }
}

function inRange(t: FuelTransaction, [s, e]: [Date, Date]): boolean {
  const d = new Date(`${t.transactionDate}T12:00:00`)
  return d >= s && d <= e
}

// ── Page ────────────────────────────────────────────────────────────────────────

export function FuelPage() {
  const [params, setParams] = useSearchParams()
  const initialRange = (RANGES.find((r) => r.key === params.get('range'))?.key ?? 'this-month') as RangeKey
  const [rangeKey, setRangeKey] = useState<RangeKey>(initialRange)
  const [uploadOpen, setUploadOpen] = useState(false)

  const { transactions, loading, addTransactions, refresh } = useFuelTransactions()
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)
  const updateEquipment = useAppStore((s) => s.updateEquipment)
  const isMobile = useIsMobile()

  const [assignSel, setAssignSel] = useState<Record<string, string>>({})
  // Card numbers hidden from the unmapped list (typos / phantom cards), kept per-browser.
  const [ignoredCards, setIgnoredCards] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('bcat.fuel.ignoredCards') ?? '[]') as string[] } catch { return [] }
  })
  const persistIgnored = (next: string[]) => {
    setIgnoredCards(next)
    try { localStorage.setItem('bcat.fuel.ignoredCards', JSON.stringify(next)) } catch { /* ignore */ }
  }

  const trucks = useMemo(() => equipment.filter((e) => e.type === 'truck'), [equipment])
  const truckById = useMemo(() => new Map(trucks.map((t) => [t.id, t])), [trucks])
  const driverById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers])

  const setRange = (key: RangeKey) => {
    setRangeKey(key)
    setParams((p) => { p.set('range', key); return p }, { replace: true })
  }

  // Truck → assigned driver name. The assignment is managed on the Drivers page and
  // stored on driver.assignedTruckId, so resolve that first; fall back to the truck's
  // own assignedDriverId if that's where it was set.
  const driverByTruckId = useMemo(() => {
    const map = new Map<string, string>()
    for (const d of drivers) {
      if (d.assignedTruckId) map.set(d.assignedTruckId, d.name)
    }
    for (const tr of trucks) {
      if (!map.has(tr.id) && tr.assignedDriverId) {
        const name = driverById.get(tr.assignedDriverId)?.name
        if (name) map.set(tr.id, name)
      }
    }
    return map
  }, [drivers, trucks, driverById])

  const driverNameForTruck = (truckId?: string | null): string | undefined =>
    truckId ? driverByTruckId.get(truckId) : undefined

  // Resolve a transaction's truck by stored truckId, else by its fuel card number — so
  // assigning a card re-maps historical fuel immediately without re-importing.
  const cardToTruck = useMemo(() => {
    const m = new Map<string, Equipment>()
    for (const tr of trucks) for (const c of tr.fuelCardNumbers ?? []) m.set(c, tr)
    return m
  }, [trucks])

  const truckForTx = (t: FuelTransaction): Equipment | undefined =>
    (t.truckId ? truckById.get(t.truckId) : undefined) ?? (t.cardNumber ? cardToTruck.get(t.cardNumber) : undefined)

  // Trucks whose driver buys their own fuel — excluded from all totals below.
  const excludedTruckIds = useMemo(() => {
    const isSelfFuel = (name?: string) => !!name && SELF_FUEL_DRIVERS.some((s) => name.toLowerCase().includes(s))
    const ids = new Set<string>()
    for (const d of drivers) if (isSelfFuel(d.name) && d.assignedTruckId) ids.add(d.assignedTruckId)
    for (const tr of trucks) {
      const dn = tr.assignedDriverId ? driverById.get(tr.assignedDriverId)?.name : undefined
      if (isSelfFuel(dn)) ids.add(tr.id)
    }
    return ids
  }, [drivers, trucks, driverById])

  // Base fuel set: real fuel, minus ignored (phantom) cards and self-fuel drivers.
  const fuelTxs = useMemo(
    () => transactions.filter(isFuel).filter((t) => {
      if (t.cardNumber && ignoredCards.includes(t.cardNumber)) return false
      const tr = truckForTx(t)
      return !(tr && excludedTruckIds.has(tr.id))
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, ignoredCards, cardToTruck, truckById, excludedTruckIds],
  )
  const range = getRange(rangeKey)
  const prev = getPrevRange(rangeKey)

  const current = useMemo(() => fuelTxs.filter((t) => inRange(t, range)), [fuelTxs, range])
  const previous = useMemo(() => (prev ? fuelTxs.filter((t) => inRange(t, prev)) : []), [fuelTxs, prev])

  const spend = current.reduce((s, t) => s + t.amount, 0)
  const gallons = current.reduce((s, t) => s + t.quantity, 0)
  const avgPerGal = gallons > 0 ? spend / gallons : 0
  const prevSpend = previous.reduce((s, t) => s + t.amount, 0)
  const spendDelta = prev && prevSpend > 0 ? Math.round(((spend - prevSpend) / prevSpend) * 100) : null

  const addTo = (map: Map<string, Agg>, key: string, t: FuelTransaction) => {
    const c = map.get(key)
    if (c) { c.spend += t.amount; c.gallons += t.quantity; c.count += 1 }
    else map.set(key, { spend: t.amount, gallons: t.quantity, count: 1 })
  }

  // Every truck in the fleet, even with $0 fuel this period.
  const byTruck = useMemo(() => {
    const agg = new Map<string, Agg>()
    for (const t of current) { const tr = truckForTx(t); addTo(agg, tr ? tr.id : '__unmapped__', t) }
    const rows: TruckFuelRow[] = trucks.filter((tr) => !excludedTruckIds.has(tr.id)).map((tr) => {
      const a = agg.get(tr.id) ?? { spend: 0, gallons: 0, count: 0 }
      const dn = driverNameForTruck(tr.id)
      return { label: `#${tr.unitNumber}`, driver: dn, noDriver: !dn, spend: a.spend, gallons: a.gallons }
    })
    const um = agg.get('__unmapped__')
    if (um && um.spend > 0) rows.push({ label: 'Unmapped', driver: 'card not matched to a truck', noDriver: true, spend: um.spend, gallons: um.gallons })
    return rows.sort((a, b) => b.spend - a.spend)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, trucks, truckById, driverById, cardToTruck, excludedTruckIds])

  const trucksFueled = byTruck.filter((r) => r.spend > 0).length
  const trucksNoDriver = trucks.filter((t) => t.active !== false && !driverByTruckId.has(t.id))

  // EFS cards that resolve to no truck (by stored id or card number). Add each to the
  // right truck below and its fuel re-maps automatically.
  const unmappedCards = useMemo(() => {
    const map = new Map<string, { card: string; spend: number; gallons: number; count: number; unit?: string; driver?: string; lastDate?: string }>()
    for (const t of fuelTxs) {
      if (truckForTx(t)) continue
      const key = t.cardNumber || '(no card #)'
      const cur = map.get(key) ?? { card: key, spend: 0, gallons: 0, count: 0 }
      cur.spend += t.amount; cur.gallons += t.quantity; cur.count += 1
      if (t.unitNumber) cur.unit = t.unitNumber
      if (t.driverName?.trim()) cur.driver = t.driverName.trim()
      if (!cur.lastDate || t.transactionDate > cur.lastDate) cur.lastDate = t.transactionDate
      map.set(key, cur)
    }
    return [...map.values()].sort((a, b) => b.spend - a.spend)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fuelTxs, cardToTruck, truckById])

  // Amazon vs Ivan (LOCAL) fleet, via each transaction's truck fleetGroup.
  const byFleet = useMemo(() => {
    const g: Record<'AMAZON' | 'LOCAL' | 'UNKNOWN', Agg> = {
      AMAZON:  { spend: 0, gallons: 0, count: 0 },
      LOCAL:   { spend: 0, gallons: 0, count: 0 },
      UNKNOWN: { spend: 0, gallons: 0, count: 0 },
    }
    for (const t of current) {
      const truck = truckForTx(t)
      const key = truck?.fleetGroup === 'AMAZON' ? 'AMAZON' : truck?.fleetGroup === 'LOCAL' ? 'LOCAL' : 'UNKNOWN'
      g[key].spend += t.amount; g[key].gallons += t.quantity; g[key].count += 1
    }
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, truckById, cardToTruck])

  // ── Fuel anomalies (same logic as fuel-anomaly-check.sh / detectFuelAnomalies.mjs) ──
  const anomalyResult = useMemo(() => {
    if (!current.length) return null
    return detectFuelAnomalies(current, 15)
  }, [current])

  function assignCard(card: string, truckId: string) {
    const truck = truckById.get(truckId)
    if (!truck || !card || card === '(no card #)') return
    const next = [...new Set([...(truck.fuelCardNumbers ?? []), card])]
    updateEquipment(truckId, { fuelCardNumbers: next })
    setAssignSel((prev) => { const n = { ...prev }; delete n[card]; return n })
    toast.success(`Card ${card} assigned to #${truck.unitNumber}`)
  }

  return (
    <TmsScrollPage
      title="Fuel"
      subtitle="Fuel spend, diesel pricing & per-mile — by truck and driver"
      actions={
        <>
          <div style={{ display: 'flex', gap: 4, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3 }}>
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                style={{
                  padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12.5,
                  fontWeight: rangeKey === r.key ? 600 : 500, fontFamily: 'inherit',
                  background: rangeKey === r.key ? 'var(--tms-card)' : 'transparent',
                  color: rangeKey === r.key ? 'var(--tms-text)' : 'var(--tms-muted)',
                  boxShadow: rangeKey === r.key ? 'var(--tms-shadow)' : 'none',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          <TmsButton variant="primary" onClick={() => setUploadOpen(true)}>
            <Upload size={14} /> Upload EFS
          </TmsButton>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* KPI strip */}
        <TmsStatRow
          columns={4}
          items={[
            { label: 'Fuel Spend', value: loading ? null : money(spend), delta: spendDelta != null ? { pct: spendDelta, label: 'vs previous period' } : null, positiveIsGood: false, sub: prev ? 'vs previous period' : 'all recorded fuel', icon: Fuel },
            { label: 'Gallons', value: loading ? null : gal(gallons), sub: `${current.length} transactions` },
            { label: 'Avg $/gal', value: loading ? null : money2(avgPerGal), sub: 'blended, this period' },
            { label: 'Trucks Fueled', value: loading ? null : `${trucksFueled} / ${trucks.length}`, sub: 'fueled this period' },
          ]}
        />

        {/* Diesel price (fuel-only; revenue & rev/mile stay on the dashboard) */}
        <DieselPriceWidget />

        {/* Amazon vs Ivan fleet — spend & pricing */}
        <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Fuel size={15} style={{ color: 'var(--tms-muted)' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Fuel by Fleet</span>
            <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>· Amazon vs Ivan</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${byFleet.UNKNOWN.spend > 0 ? 3 : 2}, 1fr)`, gap: 1, background: 'var(--tms-border)' }}>
            {([
              { key: 'AMAZON', label: 'Amazon',       color: 'var(--tms-chart-6)', agg: byFleet.AMAZON },
              { key: 'LOCAL',  label: 'Ivan (Local)', color: 'var(--tms-chart-4)', agg: byFleet.LOCAL },
              ...(byFleet.UNKNOWN.spend > 0 ? [{ key: 'UNKNOWN', label: 'Unassigned truck', color: 'var(--tms-chart-9)', agg: byFleet.UNKNOWN }] : []),
            ] as const).map((f) => {
              const perGal = f.agg.gallons > 0 ? f.agg.spend / f.agg.gallons : 0
              return (
                <div key={f.key} style={{ background: 'var(--tms-card)', padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: f.color, display: 'inline-block' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text)' }}>{f.label}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{loading ? '—' : money2(perGal)}</span>
                    <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>/ gal avg</span>
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 16, fontSize: 12, color: 'var(--tms-text-2)', flexWrap: 'wrap' }}>
                    <span><span style={{ color: 'var(--tms-muted)' }}>Spend</span> <b style={{ fontVariantNumeric: 'tabular-nums' }}>{money(f.agg.spend)}</b></span>
                    <span><span style={{ color: 'var(--tms-muted)' }}>Gallons</span> <b style={{ fontVariantNumeric: 'tabular-nums' }}>{gal(f.agg.gallons)}</b></span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Fuel Anomalies ────────────────────────────────────────────────────── */}
        {anomalyResult && (
          <div style={{ background: 'var(--tms-card)', border: `1px solid ${anomalyResult.anomalies.length ? 'var(--tms-badge-orange)' : 'var(--tms-border)'}`, borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {anomalyResult.anomalies.length ? (
                <AlertTriangle size={15} style={{ color: 'var(--tms-badge-orange)' }} />
              ) : (
                <ShieldCheck size={15} style={{ color: 'var(--tms-badge-green)' }} />
              )}
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Fuel Price Anomalies</span>
              <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>
                · {anomalyResult.anomalies.length
                  ? `${anomalyResult.anomalies.length} overpay transaction(s) >${anomalyResult.thresholdPct}% above fleet average`
                  : `No overpay transactions >${anomalyResult.thresholdPct}% above fleet average`}
              </span>
            </div>

            {/* Fleet Averages */}
            <div style={{ padding: '12px 20px', borderBottom: anomalyResult.anomalies.length ? '1px solid var(--tms-border)' : 'none', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {anomalyResult.fleetAverages.map((fa) => (
                <div key={fa.fuelType} style={{ fontSize: 12.5, color: 'var(--tms-text-2)' }}>
                  <span style={{ fontWeight: 600, color: 'var(--tms-text)', fontFamily: 'var(--font-mono)' }}>{fa.fuelType}</span>
                  {' '}
                  <span style={{ color: 'var(--tms-muted)' }}>avg</span>{' '}
                  <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--tms-text)' }}>{money2(fa.avgPricePerGallon)}</b>
                  <span style={{ color: 'var(--tms-muted)' }}>/gal</span>{' '}
                  <span style={{ fontSize: 11.5, color: 'var(--tms-muted)' }}>({fa.count} txns, {gal(fa.totalGallons)})</span>
                </div>
              ))}
            </div>

            {/* Anomaly rows */}
            {anomalyResult.anomalies.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 800 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
                      {['Date', 'Truck', 'Driver', 'Location', 'Type', '$/gal', 'Fleet Avg', 'Overpay %', 'Overpay $', 'Gallons'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 16px', textAlign: i >= 5 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {anomalyResult.anomalies.map((a) => (
                      <tr key={a.id} style={{ borderBottom: '1px solid var(--tms-border)' }}>
                        <td style={{ padding: '9px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--tms-text)' }}>{a.transactionDate}</td>
                        <td style={{ padding: '9px 16px', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--tms-text)' }}>{a.truckUnit}</td>
                        <td style={{ padding: '9px 16px', color: a.driver ? 'var(--tms-text-2)' : 'var(--tms-badge-orange)', fontWeight: a.driver ? 400 : 600 }}>{a.driver || '—'}</td>
                        <td style={{ padding: '9px 16px', color: 'var(--tms-text-2)', fontSize: 12 }}>{a.location || '—'}</td>
                        <td style={{ padding: '9px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--tms-text-2)' }}>{a.fuelType}</td>
                        <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--tms-badge-red)' }}>{money2(a.pricePerGallon)}</td>
                        <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--tms-text-2)' }}>{money2(a.fleetAverage)}</td>
                        <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--tms-badge-red)' }}>+{a.overpayPct}%</td>
                        <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--tms-badge-red)' }}>{money2(a.overpayAmount)}</td>
                        <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--tms-muted)' }}>{gal(a.gallons)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Trucks missing a driver — their fuel lands in "Unassigned" */}
        {trucksNoDriver.length > 0 && (
          <TmsAlert tone="orange" icon={false}>
            <span>
              <b>{trucksNoDriver.length}</b> {trucksNoDriver.length === 1 ? 'truck has' : 'trucks have'} no driver assigned
              ({trucksNoDriver.map((t) => `#${t.unitNumber}`).join(', ')}) — their fuel shows under “Unassigned”. Assign drivers on the Drivers page.
            </span>
          </TmsAlert>
        )}

        {/* Fuel by truck — what the cards were charged. */}
        <FuelByTruckTable rows={byTruck} loading={loading} />

        {/*
          Fuel economy, which is a different question from fuel spend and comes from a
          different place: Motive's own miles and fuel, not the cards. A card transaction is
          money leaving on a date, not fuel burned in a period.
        */}
        <TruckMpgTable />

        {/* Unmapped fuel cards — not attached to any truck (all time) */}
        {(unmappedCards.length > 0 || ignoredCards.length > 0) && (
          <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-badge-orange)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={15} style={{ color: 'var(--tms-badge-orange)' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Unmapped fuel cards</span>
              <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>· {unmappedCards.length} not attached to a truck (all time)</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
                    {['Card #', 'EFS unit', 'EFS driver', 'Spend', 'Gallons', 'Last seen', 'Assign to truck'].map((h, i) => (
                      <th key={h} style={{ padding: '8px 16px', textAlign: i >= 3 && i <= 4 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {unmappedCards.map((c) => (
                    <tr key={c.card} style={{ borderBottom: '1px solid var(--tms-border)' }}>
                      <td style={{ padding: '9px 16px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--tms-text)' }}>{c.card}</td>
                      <td style={{ padding: '9px 16px', color: 'var(--tms-text-2)' }}>{c.unit ? `#${c.unit}` : '—'}</td>
                      <td style={{ padding: '9px 16px', color: 'var(--tms-text-2)' }}>{c.driver ?? '—'}</td>
                      <td style={{ padding: '9px 16px', textAlign: 'right', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{money(c.spend)}</td>
                      <td style={{ padding: '9px 16px', textAlign: 'right', color: 'var(--tms-muted)', fontFamily: 'var(--font-mono)' }}>{gal(c.gallons)}</td>
                      <td style={{ padding: '9px 16px', color: 'var(--tms-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.lastDate ?? '—'}</td>
                      <td style={{ padding: '9px 16px' }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <select
                            value={assignSel[c.card] ?? ''}
                            onChange={(e) => setAssignSel((prev) => ({ ...prev, [c.card]: e.target.value }))}
                            disabled={c.card === '(no card #)'}
                            style={{ height: 30, padding: '0 8px', borderRadius: 6, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text)', fontSize: 12.5, fontFamily: 'inherit', maxWidth: 150 }}
                          >
                            <option value="">Select truck…</option>
                            {trucks.filter((t) => t.active !== false).map((t) => (
                              <option key={t.id} value={t.id}>#{t.unitNumber}{driverNameForTruck(t.id) ? ` · ${driverNameForTruck(t.id)}` : ''}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => assignSel[c.card] && assignCard(c.card, assignSel[c.card])}
                            disabled={!assignSel[c.card] || c.card === '(no card #)'}
                            style={{ height: 30, padding: '0 12px', borderRadius: 6, border: 'none', background: 'var(--tms-primary)', color: 'var(--tms-on-primary)', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit', cursor: assignSel[c.card] ? 'pointer' : 'default', opacity: assignSel[c.card] ? 1 : 0.5 }}
                          >
                            Assign
                          </button>
                          {c.card !== '(no card #)' && (
                            <button
                              onClick={() => persistIgnored([...new Set([...ignoredCards, c.card])])}
                              title="Hide this card — it’s a typo or phantom, not a real card"
                              style={{ height: 30, padding: '0 10px', borderRadius: 6, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-muted)', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer' }}
                            >
                              Ignore
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {unmappedCards.length === 0 && (
                    <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--tms-muted)', fontSize: 13 }}>No unmapped cards — all fuel is attached to a truck.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid var(--tms-border)', fontSize: 11.5, color: 'var(--tms-muted)', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span>Pick a truck and hit Assign — the card re-maps to that truck &amp; driver instantly. Use Ignore for typo/phantom cards. If a truck isn’t listed, create it on the Fleet page first.</span>
              {ignoredCards.length > 0 && (
                <button onClick={() => persistIgnored([])} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--tms-primary)', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {ignoredCards.length} hidden · Show all
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {uploadOpen && (
        <FuelUploadModal
          trucks={trucks}
          onImported={(added) => addTransactions(added)}
          onChanged={refresh}
          onClose={() => setUploadOpen(false)}
        />
      )}
    </TmsScrollPage>
  )
}

// ── Bits ────────────────────────────────────────────────────────────────────────

interface TruckFuelRow {
  label: string; driver?: string; noDriver: boolean
  spend: number; gallons: number
}

function FuelByTruckTable({ rows, loading }: { rows: TruckFuelRow[]; loading: boolean }) {
  const th: React.CSSProperties = { padding: '8px 16px', fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '9px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }
  return (
    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <TruckIcon size={15} style={{ color: 'var(--tms-muted)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Fuel by Truck</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 520 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
              <th style={{ ...th, textAlign: 'left' }}>Truck</th>
              <th style={{ ...th, textAlign: 'left' }}>Driver</th>
              <th style={{ ...th, textAlign: 'right' }}>Fuel $</th>
              <th style={{ ...th, textAlign: 'right' }}>Gallons</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} style={{ padding: 28, textAlign: 'center', color: 'var(--tms-muted)' }}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: 28, textAlign: 'center', color: 'var(--tms-muted)' }}>No trucks</td></tr>
            ) : rows.map((r) => (
              <tr key={r.label} style={{ borderBottom: '1px solid var(--tms-border)' }}>
                <td style={{ padding: '9px 16px', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--tms-text)' }}>{r.label}</td>
                <td style={{ padding: '9px 16px', color: r.noDriver ? 'var(--tms-badge-orange)' : 'var(--tms-text-2)', fontWeight: r.noDriver ? 600 : 400 }}>{r.driver ?? '—'}</td>
                <td style={{ ...td, fontWeight: 600, color: 'var(--tms-text)' }}>{money(r.spend)}</td>
                <td style={{ ...td, color: 'var(--tms-text-2)' }}>{r.gallons > 0 ? gal(r.gallons) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

