import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, subWeeks, subMonths } from 'date-fns'
import { Fuel, Upload, TrendingUp, TrendingDown, Truck as TruckIcon, AlertTriangle } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useFuelTransactions, type FuelTransaction } from '@/hooks/useFuelTransactions'
import { useIsMobile } from '@/hooks/useIsMobile'
import { DieselPriceWidget } from '@/features/dashboard/DieselPriceWidget'
import { FuelUploadModal } from '@/features/expenses/FuelUploadModal'
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

  function assignCard(card: string, truckId: string) {
    const truck = truckById.get(truckId)
    if (!truck || !card || card === '(no card #)') return
    const next = [...new Set([...(truck.fuelCardNumbers ?? []), card])]
    updateEquipment(truckId, { fuelCardNumbers: next })
    setAssignSel((prev) => { const n = { ...prev }; delete n[card]; return n })
    toast.success(`Card ${card} assigned to #${truck.unitNumber}`)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
              <Fuel size={19} style={{ color: 'var(--ds-t3)' }} /> Fuel
            </h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>Fuel spend, diesel pricing &amp; per-mile — by truck and driver</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 4, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3 }}>
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  style={{
                    padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12.5,
                    fontWeight: rangeKey === r.key ? 600 : 500, fontFamily: 'inherit',
                    background: rangeKey === r.key ? '#fff' : 'transparent',
                    color: rangeKey === r.key ? 'var(--ds-t1)' : 'var(--ds-t3)',
                    boxShadow: rangeKey === r.key ? 'var(--sh-sm)' : 'none',
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setUploadOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 13px', borderRadius: 8, background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit' }}
            >
              <Upload size={14} /> Upload EFS
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0,1fr))' : 'repeat(4, minmax(0,1fr))', gap: 16 }}>
          <StatCard label="Fuel Spend" value={loading ? '—' : money(spend)} accent="#f59e0b"
            right={spendDelta != null && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 600, color: spendDelta > 0 ? '#dc2626' : '#16a34a' }}>
                {spendDelta > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{Math.abs(spendDelta)}%
              </span>
            )}
            sub={prev ? 'vs previous period' : 'all recorded fuel'} />
          <StatCard label="Gallons" value={loading ? '—' : gal(gallons)} accent="#1ea8f3" sub={`${current.length} transactions`} />
          <StatCard label="Avg $/gal" value={loading ? '—' : money2(avgPerGal)} accent="#16a34a" sub="blended, this period" />
          <StatCard label="Trucks Fueled" value={loading ? '—' : `${trucksFueled} / ${trucks.length}`} accent="#6366f1" sub="fueled this period" />
        </div>

        {/* Diesel price (fuel-only; revenue & rev/mile stay on the dashboard) */}
        <DieselPriceWidget />

        {/* Amazon vs Ivan fleet — spend & pricing */}
        <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Fuel size={15} style={{ color: 'var(--ds-t3)' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Fuel by Fleet</span>
            <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>· Amazon vs Ivan</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${byFleet.UNKNOWN.spend > 0 ? 3 : 2}, 1fr)`, gap: 1, background: 'var(--ds-border)' }}>
            {([
              { key: 'AMAZON', label: 'Amazon',       color: '#6366f1', agg: byFleet.AMAZON },
              { key: 'LOCAL',  label: 'Ivan (Local)', color: '#f59e0b', agg: byFleet.LOCAL },
              ...(byFleet.UNKNOWN.spend > 0 ? [{ key: 'UNKNOWN', label: 'Unassigned truck', color: '#94a3b8', agg: byFleet.UNKNOWN }] : []),
            ] as const).map((f) => {
              const perGal = f.agg.gallons > 0 ? f.agg.spend / f.agg.gallons : 0
              return (
                <div key={f.key} style={{ background: 'var(--ds-surface)', padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: f.color, display: 'inline-block' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}>{f.label}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{loading ? '—' : money2(perGal)}</span>
                    <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>/ gal avg</span>
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 16, fontSize: 12, color: 'var(--ds-t2)', flexWrap: 'wrap' }}>
                    <span><span style={{ color: 'var(--ds-t3)' }}>Spend</span> <b style={{ fontVariantNumeric: 'tabular-nums' }}>{money(f.agg.spend)}</b></span>
                    <span><span style={{ color: 'var(--ds-t3)' }}>Gallons</span> <b style={{ fontVariantNumeric: 'tabular-nums' }}>{gal(f.agg.gallons)}</b></span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Trucks missing a driver — their fuel lands in "Unassigned" */}
        {trucksNoDriver.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px' }}>
            <AlertTriangle size={15} style={{ color: '#b45309', flexShrink: 0 }} />
            <span>
              <b>{trucksNoDriver.length}</b> {trucksNoDriver.length === 1 ? 'truck has' : 'trucks have'} no driver assigned
              ({trucksNoDriver.map((t) => `#${t.unitNumber}`).join(', ')}) — their fuel shows under “Unassigned”. Assign drivers on the Drivers page.
            </span>
          </div>
        )}

        {/* Fuel by truck — with miles & MPG */}
        <FuelByTruckTable rows={byTruck} loading={loading} />

        {/* Unmapped fuel cards — not attached to any truck (all time) */}
        {(unmappedCards.length > 0 || ignoredCards.length > 0) && (
          <div style={{ background: 'var(--ds-surface)', border: '1px solid #fde68a', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={15} style={{ color: '#b45309' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Unmapped fuel cards</span>
              <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>· {unmappedCards.length} not attached to a truck (all time)</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    {['Card #', 'EFS unit', 'EFS driver', 'Spend', 'Gallons', 'Last seen', 'Assign to truck'].map((h, i) => (
                      <th key={h} style={{ padding: '8px 16px', textAlign: i >= 3 && i <= 4 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {unmappedCards.map((c) => (
                    <tr key={c.card} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                      <td style={{ padding: '9px 16px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--ds-t1)' }}>{c.card}</td>
                      <td style={{ padding: '9px 16px', color: 'var(--ds-t2)' }}>{c.unit ? `#${c.unit}` : '—'}</td>
                      <td style={{ padding: '9px 16px', color: 'var(--ds-t2)' }}>{c.driver ?? '—'}</td>
                      <td style={{ padding: '9px 16px', textAlign: 'right', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{money(c.spend)}</td>
                      <td style={{ padding: '9px 16px', textAlign: 'right', color: 'var(--ds-t3)', fontFamily: 'var(--font-mono)' }}>{gal(c.gallons)}</td>
                      <td style={{ padding: '9px 16px', color: 'var(--ds-t3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.lastDate ?? '—'}</td>
                      <td style={{ padding: '9px 16px' }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <select
                            value={assignSel[c.card] ?? ''}
                            onChange={(e) => setAssignSel((prev) => ({ ...prev, [c.card]: e.target.value }))}
                            disabled={c.card === '(no card #)'}
                            style={{ height: 30, padding: '0 8px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)', fontSize: 12.5, fontFamily: 'inherit', maxWidth: 150 }}
                          >
                            <option value="">Select truck…</option>
                            {trucks.filter((t) => t.active !== false).map((t) => (
                              <option key={t.id} value={t.id}>#{t.unitNumber}{driverNameForTruck(t.id) ? ` · ${driverNameForTruck(t.id)}` : ''}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => assignSel[c.card] && assignCard(c.card, assignSel[c.card])}
                            disabled={!assignSel[c.card] || c.card === '(no card #)'}
                            style={{ height: 30, padding: '0 12px', borderRadius: 6, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit', cursor: assignSel[c.card] ? 'pointer' : 'default', opacity: assignSel[c.card] ? 1 : 0.5 }}
                          >
                            Assign
                          </button>
                          {c.card !== '(no card #)' && (
                            <button
                              onClick={() => persistIgnored([...new Set([...ignoredCards, c.card])])}
                              title="Hide this card — it’s a typo or phantom, not a real card"
                              style={{ height: 30, padding: '0 10px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t3)', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer' }}
                            >
                              Ignore
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {unmappedCards.length === 0 && (
                    <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>No unmapped cards — all fuel is attached to a truck.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid var(--ds-border)', fontSize: 11.5, color: 'var(--ds-t3)', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span>Pick a truck and hit Assign — the card re-maps to that truck &amp; driver instantly. Use Ignore for typo/phantom cards. If a truck isn’t listed, create it on the Fleet page first.</span>
              {ignoredCards.length > 0 && (
                <button onClick={() => persistIgnored([])} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ds-blue)', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }}>
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
    </div>
  )
}

// ── Bits ────────────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent, right }: { label: string; value: string; sub?: string; accent: string; right?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '16px 18px', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: -40, right: -40, width: 130, height: 130, borderRadius: '50%', background: accent, filter: 'blur(60px)', opacity: 0.16, pointerEvents: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>{label}</div>
        {right}
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

interface TruckFuelRow {
  label: string; driver?: string; noDriver: boolean
  spend: number; gallons: number
}

function FuelByTruckTable({ rows, loading }: { rows: TruckFuelRow[]; loading: boolean }) {
  const th: React.CSSProperties = { padding: '8px 16px', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '9px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <TruckIcon size={15} style={{ color: 'var(--ds-t3)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Fuel by Truck</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 520 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              <th style={{ ...th, textAlign: 'left' }}>Truck</th>
              <th style={{ ...th, textAlign: 'left' }}>Driver</th>
              <th style={{ ...th, textAlign: 'right' }}>Fuel $</th>
              <th style={{ ...th, textAlign: 'right' }}>Gallons</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} style={{ padding: 28, textAlign: 'center', color: 'var(--ds-t3)' }}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: 28, textAlign: 'center', color: 'var(--ds-t3)' }}>No trucks</td></tr>
            ) : rows.map((r) => (
              <tr key={r.label} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <td style={{ padding: '9px 16px', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ds-t1)' }}>{r.label}</td>
                <td style={{ padding: '9px 16px', color: r.noDriver ? '#b45309' : 'var(--ds-t2)', fontWeight: r.noDriver ? 600 : 400 }}>{r.driver ?? '—'}</td>
                <td style={{ ...td, fontWeight: 600, color: 'var(--ds-t1)' }}>{money(r.spend)}</td>
                <td style={{ ...td, color: 'var(--ds-t2)' }}>{r.gallons > 0 ? gal(r.gallons) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

