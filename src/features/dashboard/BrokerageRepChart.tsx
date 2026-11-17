import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { repMonthMatrix, type DivisionFilter, type DivisionShape, type Measures, type RepMonth, type RepMonthRow, type RepNames } from '@/lib/brokerageRevenue'
import { money0, moneyCompact, netColor, pct } from './brokerageFormat'
import { monthShort } from './brokerageInsights'

type Figure = 'profit' | 'revenue' | 'loads'
const FIGURES: { key: Figure; label: string }[] = [{ key: 'profit', label: 'Profit' }, { key: 'revenue', label: 'Revenue' }, { key: 'loads', label: 'Loads' }]
const DIVISIONS: { key: DivisionFilter; label: string }[] = [
  { key: 'BROKERAGE', label: 'Brokerage' }, { key: 'ASSETS', label: 'Assets' }, { key: 'CAR_SHIPPING', label: 'Car shipping' }, { key: 'ALL', label: 'All' },
]
const TOP = 6

const valueOf = (m: Measures, f: Figure) => (f === 'loads' ? m.loads : f === 'revenue' ? m.revenueCents : m.profitCents)
const show = (v: number, f: Figure) => (f === 'loads' ? String(v) : moneyCompact(v))

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 3, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const on = o.key === value
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange(o.key)} style={{
            padding: '3px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
            fontWeight: on ? 600 : 500, background: on ? 'var(--tms-card)' : 'transparent', color: on ? 'var(--tms-text)' : 'var(--tms-muted)', boxShadow: on ? 'var(--tms-shadow)' : 'none',
          }}>{o.label}</button>
        )
      })}
    </div>
  )
}

/**
 * Who earns what: one bar per sales rep for the chosen range, biggest first. Click a rep for their month-by-month
 * numbers. Smaller reps past the first six fold into one "Other reps" bar so the chart stays short.
 */
export function BrokerageRepChart({ repMonths, divisions, names, months, current, ready, own }: {
  repMonths: RepMonth[]
  divisions: DivisionShape[]
  names: RepNames
  months: string[]
  current: string
  ready: boolean
  own: boolean
}) {
  const [figure, setFigure] = useState<Figure>('profit')
  const [division, setDivision] = useState<DivisionFilter>('BROKERAGE')
  const [open, setOpen] = useState<string | null>(null)
  const matrix = useMemo(() => repMonthMatrix(repMonths, months, divisions, names, division), [repMonths, months, divisions, names, division])

  const bars = useMemo(() => {
    const sorted = [...matrix.reps].sort((a, b) => valueOf(b.total, figure) - valueOf(a.total, figure))
    const head = sorted.slice(0, TOP)
    const rest = sorted.slice(TOP)
    return { head, rest, restTotal: rest.reduce((s, r) => s + valueOf(r.total, figure), 0) }
  }, [matrix.reps, figure])
  const scale = Math.max(1, ...bars.head.map((r) => Math.abs(valueOf(r.total, figure))), Math.abs(bars.restTotal))

  if (!ready) {
    return (
      <div className="tms-card" data-testid="brokerage-rep-chart" style={{ padding: 20, fontSize: 13, color: 'var(--tms-muted)' }}>
        The sales-rep split is not ready for these months yet. It fills in as each month is recomputed; the figures above are already complete.
      </div>
    )
  }

  const bar = (v: number, color: string) => (
    <div style={{ height: 10, borderRadius: 999, background: 'var(--tms-bg)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(2, (Math.abs(v) / scale) * 100)}%`, height: '100%', borderRadius: 999, background: v < 0 ? 'var(--tms-badge-red)' : color }} />
    </div>
  )

  return (
    <div className="tms-card dash-card" data-testid="brokerage-rep-chart" style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Seg label="Figure" value={figure} options={FIGURES} onChange={setFigure} />
        {!own && <Seg label="Division" value={division} options={DIVISIONS} onChange={(d) => { setDivision(d); setOpen(null) }} />}
      </div>

      {matrix.reps.length === 0 ? (
        <div data-testid="brokerage-rep-empty" style={{ padding: '12px 0', fontSize: 13, color: 'var(--tms-muted)' }}>No delivered loads with a rate in these months for this division.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {bars.head.map((r: RepMonthRow) => {
            const key = r.repKey || 'none'
            const isOpen = open === key
            return (
              <div key={key} data-testid="brokerage-rep-bar" style={{ borderTop: '1px solid var(--tms-border)' }}>
                <button
                  type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}
                  style={{ all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'grid', gridTemplateColumns: 'minmax(110px, 190px) minmax(0, 1fr) auto', alignItems: 'center', gap: 14, padding: '9px 0' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--tms-text)', fontStyle: r.repKey === '' ? 'italic' : undefined, minWidth: 0 }}>
                    {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                    <span style={{ overflowWrap: 'anywhere' }}>{r.label}</span>
                  </span>
                  {bar(valueOf(r.total, figure), 'var(--tms-chart-1)')}
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: figure === 'profit' ? netColor(r.total.profitCents) : 'var(--tms-text)' }}>{show(valueOf(r.total, figure), figure)}</span>
                    {figure === 'profit' && <span style={{ fontSize: 11.5, color: 'var(--tms-muted)', marginLeft: 8 }}>{pct(r.total.marginBps)}</span>}
                  </span>
                </button>
                {isOpen && (
                  <div data-testid="brokerage-rep-detail" style={{ overflowX: 'auto', padding: '0 0 10px 20px' }}>
                    <table style={{ borderCollapse: 'collapse', minWidth: 360, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
                      <thead>
                        <tr style={{ color: 'var(--tms-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {['Month', 'Loads', 'Revenue', 'Profit', 'Margin'].map((h, i) => <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '4px 12px 4px 0', fontWeight: 600 }}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {r.byMonth.map((m, i) => (
                          <tr key={matrix.months[i]} style={{ borderTop: '1px solid var(--tms-border)' }}>
                            <td style={{ padding: '4px 12px 4px 0' }}>{monthShort(matrix.months[i])}{matrix.months[i] === current ? ' · to date' : ''}</td>
                            <td style={{ textAlign: 'right', padding: '4px 12px 4px 0' }}>{m.loads}</td>
                            <td style={{ textAlign: 'right', padding: '4px 12px 4px 0' }}>{money0(m.revenueCents)}</td>
                            <td style={{ textAlign: 'right', padding: '4px 12px 4px 0', color: netColor(m.profitCents), fontWeight: 600 }}>{money0(m.profitCents)}</td>
                            <td style={{ textAlign: 'right', padding: '4px 0' }}>{pct(m.marginBps)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
          {bars.rest.length > 0 && (
            <div style={{ borderTop: '1px solid var(--tms-border)', display: 'grid', gridTemplateColumns: 'minmax(110px, 190px) minmax(0, 1fr) auto', alignItems: 'center', gap: 14, padding: '9px 0' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text-2)', paddingLeft: 20 }}>{`Other reps (${bars.rest.length})`}</span>
              {bar(bars.restTotal, 'var(--tms-chart-9)')}
              <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{show(bars.restTotal, figure)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
