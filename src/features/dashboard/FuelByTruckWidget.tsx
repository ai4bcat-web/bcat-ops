import { useEffect, useMemo, useState } from 'react'
import { Droplet } from 'lucide-react'
import { useFuelTransactions } from '@/hooks/useFuelTransactions'
import { useTrucks } from '@/hooks/useTrucks'
import { listDriverPaySettings } from '@/lib/apiClient'
import { fuelDedupKey, normalizeCard, isFuelTx } from '@/lib/driverFuel'
import { sundayOf, shiftWeek } from '@/features/driver-pay/week'

const PERIODS = 6
const money0 = (n: number) => (n ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n) : '—')

const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

type View = 'week' | 'month'

function weekStartISO(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}
const weekLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
const monthLabel = (key: string) => new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })

/**
 * Fuel spend by truck, per week or month — for the Ivan/LOCAL fleet (Amazon cards
 * excluded). Rows are trucks, columns are the last {PERIODS} periods + a total.
 */
export function FuelByTruckWidget() {
  const { transactions, loading } = useFuelTransactions()
  const { trucks } = useTrucks()
  const [view, setView] = useState<View>('week')
  const [amazonCards, setAmazonCards] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    listDriverPaySettings()
      .then((settings) => {
        if (!alive) return
        setAmazonCards(new Set(settings
          .filter((s) => (s.payGroup ?? 'AMAZON') === 'AMAZON' && s.active !== false && s.fuelCardNumber)
          .map((s) => normalizeCard(s.fuelCardNumber)).filter(Boolean)))
      })
      .catch(() => { /* don't exclude on failure */ })
    return () => { alive = false }
  }, [])

  // LOCAL trucks only: truckId → unit and card → unit, so each fill maps to a truck.
  const { unitByTruckId, unitByCard, localUnits } = useMemo(() => {
    const unitByTruckId = new Map<string, string>()
    const unitByCard = new Map<string, string>()
    const localUnits = new Set<string>()
    for (const e of trucks) {
      if (e.fleetGroup && e.fleetGroup !== 'LOCAL') continue
      unitByTruckId.set(e.id, e.unitNumber)
      localUnits.add(e.unitNumber)
      for (const card of e.fuelCardNumbers ?? []) { const c = normalizeCard(card); if (c) unitByCard.set(c, e.unitNumber) }
    }
    return { unitByTruckId, unitByCard, localUnits }
  }, [trucks])

  const { periods, rows, totalsByPeriod, grand } = useMemo(() => {
    const periodKey = (iso: string) => (view === 'week' ? weekStartISO(iso) : iso.slice(0, 7))

    // Ordered period buckets (oldest → newest).
    const periods: { id: string; label: string }[] = []
    if (view === 'week') {
      for (let i = PERIODS - 1; i >= 0; i--) { const ws = shiftWeek(sundayOf(), -i); periods.push({ id: ws, label: weekLabel(ws) }) }
    } else {
      const now = new Date()
      for (let i = PERIODS - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        const id = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        periods.push({ id, label: monthLabel(id) })
      }
    }
    const periodIds = new Set(periods.map((p) => p.id))

    // spend[unit][periodId] = $
    const spend = new Map<string, Map<string, number>>()
    const seen = new Set<string>()
    for (const t of transactions) {
      if (!isFuelTx(t)) continue
      const card = normalizeCard(t.cardNumber)
      if (amazonCards.has(card)) continue
      const unit = (t.truckId && unitByTruckId.get(t.truckId)) || unitByCard.get(card) || (t.unitNumber && localUnits.has(t.unitNumber) ? t.unitNumber : null)
      if (!unit) continue
      const pid = periodKey(t.transactionDate)
      if (!periodIds.has(pid)) continue
      const k = fuelDedupKey(t)
      if (seen.has(k)) continue
      seen.add(k)
      if (!spend.has(unit)) spend.set(unit, new Map())
      const m = spend.get(unit)!
      m.set(pid, (m.get(pid) ?? 0) + (t.amount || 0))
    }

    const rows = [...spend.entries()]
      .map(([unit, m]) => {
        const cells = periods.map((p) => Math.round((m.get(p.id) ?? 0)))
        return { unit, cells, total: cells.reduce((s, c) => s + c, 0) }
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)

    const totalsByPeriod = periods.map((_, i) => rows.reduce((s, r) => s + r.cells[i], 0))
    const grand = rows.reduce((s, r) => s + r.total, 0)
    return { periods, rows, totalsByPeriod, grand }
  }, [transactions, view, amazonCards, unitByTruckId, unitByCard, localUnits])

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Droplet size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Fuel spend by truck</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Ivan fleet · last {PERIODS} {view}s</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
          {(['week', 'month'] as View[]).map((v) => {
            const active = view === v
            return (
              <button key={v} onClick={() => setView(v)}
                style={{ padding: '5px 10px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
                  background: active ? 'var(--ds-surface)' : 'transparent', color: active ? 'var(--ds-t1)' : 'var(--ds-t2)', boxShadow: active ? 'var(--sh-sm)' : 'none' }}>
                {v}
              </button>
            )
          })}
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No fleet fuel in the last {PERIODS} {view}s.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Truck</th>
                {periods.map((p) => <th key={p.id} style={TH}>{p.label}</th>)}
                <th style={TH}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.unit} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td style={{ ...TD, textAlign: 'left', fontFamily: 'monospace', fontWeight: 700 }}>#{r.unit}</td>
                  {r.cells.map((c, i) => <td key={i} style={{ ...TD, color: c ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{money0(c)}</td>)}
                  <td style={{ ...TD, fontWeight: 700 }}>{money0(r.total)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: '2px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>Fleet total</td>
                {totalsByPeriod.map((c, i) => <td key={i} style={{ ...TD, fontWeight: 700 }}>{money0(c)}</td>)}
                <td style={{ ...TD, fontWeight: 800, color: 'var(--ds-blue)' }}>{money0(grand)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
