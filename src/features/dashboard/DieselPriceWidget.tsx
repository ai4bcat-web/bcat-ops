import { useEffect, useMemo, useState } from 'react'
import { Fuel, ArrowUp, ArrowDown } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useFuelTransactions, type FuelTransaction } from '@/hooks/useFuelTransactions'
import { listDriverPaySettings } from '@/lib/apiClient'
import { fuelDedupKey, normalizeCard } from '@/lib/driverFuel'
import { sundayOf, shiftWeek } from '@/features/driver-pay/week'

// Diesel + blends only — excludes DEF, discount/cardlock, scale, cash.
const DIESEL_TYPES = new Set(['ULSD', 'FUEL', 'B5', 'B20', 'REG', 'PREM', 'DSL', 'BIO'])
const isDiesel = (tx: FuelTransaction) => DIESEL_TYPES.has((tx.fuelType ?? '').toUpperCase().trim())

const WEEKS = 12
const MONTHS = 12
const perGal = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 })
const perGal2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

function weekStartISO(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()) // back to Sunday
  return d.toISOString().slice(0, 10)
}
function weekLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
}
function monthLabel(key: string): string {
  return new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
}

type View = 'week' | 'month'

/**
 * Current average diesel price for the Ivan/fleet trucks — gallons-weighted from our own
 * fuel purchases, by week or by month. Amazon drivers' cards are excluded.
 */
export function DieselPriceWidget() {
  const { transactions, loading } = useFuelTransactions()
  const [view, setView] = useState<View>('week')
  const [amazonCards, setAmazonCards] = useState<Set<string>>(new Set())

  // Amazon driver fuel cards — excluded from the fleet diesel average.
  useEffect(() => {
    let alive = true
    listDriverPaySettings()
      .then((settings) => {
        if (!alive) return
        const cards = settings
          .filter((s) => (s.payGroup ?? 'AMAZON') === 'AMAZON' && s.active !== false && s.fuelCardNumber)
          .map((s) => normalizeCard(s.fuelCardNumber))
          .filter(Boolean)
        setAmazonCards(new Set(cards))
      })
      .catch(() => { /* if it fails, just don't exclude — better than blank */ })
    return () => { alive = false }
  }, [])

  const { series, current, delta } = useMemo(() => {
    const key = (iso: string) => (view === 'week' ? weekStartISO(iso) : iso.slice(0, 7))

    // Fleet diesel fills (exclude Amazon cards + non-diesel), de-duplicated, by period.
    const seen = new Set<string>()
    const byPeriod = new Map<string, { amount: number; qty: number }>()
    for (const t of transactions) {
      if (!isDiesel(t) || !(t.quantity > 0)) continue
      if (amazonCards.has(normalizeCard(t.cardNumber))) continue
      const k = fuelDedupKey(t)
      if (seen.has(k)) continue
      seen.add(k)
      const p = key(t.transactionDate)
      const acc = byPeriod.get(p) ?? { amount: 0, qty: 0 }
      acc.amount += t.amount || 0; acc.qty += t.quantity || 0
      byPeriod.set(p, acc)
    }

    // Ordered period buckets (oldest → newest).
    const buckets: { id: string; label: string }[] = []
    if (view === 'week') {
      for (let i = WEEKS - 1; i >= 0; i--) { const ws = shiftWeek(sundayOf(), -i); buckets.push({ id: ws, label: weekLabel(ws) }) }
    } else {
      const now = new Date()
      for (let i = MONTHS - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        const id = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        buckets.push({ id, label: monthLabel(id) })
      }
    }

    const series = buckets.map(({ id, label }) => {
      const acc = byPeriod.get(id)
      return { period: label, price: acc && acc.qty > 0 ? Math.round((acc.amount / acc.qty) * 1000) / 1000 : null }
    })
    const withData = series.filter((s) => s.price != null)
    const current = withData.length ? withData[withData.length - 1].price : null
    const prev = withData.length >= 2 ? withData[withData.length - 2].price : null
    const delta = current != null && prev != null ? current - prev : null
    return { series, current, delta }
  }, [transactions, amazonCards, view])

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Fuel size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Diesel price</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Fleet average $/gal · by {view}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {current != null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {perGal.format(current)}<span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t3)', letterSpacing: 0 }}>/gal</span>
              </div>
              {delta != null && Math.abs(delta) >= 0.001 && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 600, marginTop: 2, color: delta < 0 ? '#15803d' : '#dc2626' }}>
                  {delta < 0 ? <ArrowDown size={13} /> : <ArrowUp size={13} />}{perGal.format(Math.abs(delta))} <span style={{ fontWeight: 500, color: 'var(--ds-t3)' }}>{view === 'week' ? 'wk/wk' : 'mo/mo'}</span>
                </div>
              )}
            </div>
          )}
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
      </div>

      <div style={{ padding: '12px 12px 6px' }}>
        {loading && current == null ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
        ) : current == null ? (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No fleet diesel purchases recorded yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={series} margin={{ top: 8, right: 20, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="rgba(15,23,42,0.05)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="period" tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => perGal2.format(Number(v))} domain={['auto', 'auto']} tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip formatter={(v) => [perGal.format(Number(v)), 'Avg $/gal']}
                contentStyle={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: 'var(--sh-md)' }} />
              <Line type="monotone" dataKey="price" name="Avg $/gal" stroke="#1ea8f3" strokeWidth={2} dot={{ r: 3 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
