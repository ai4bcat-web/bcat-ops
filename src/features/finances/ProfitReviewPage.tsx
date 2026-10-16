import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, AlertTriangle, TrendingUp, Fuel, Users, Wrench, Package, Calculator, ListChecks } from 'lucide-react'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useProfitReview } from '@/hooks/useProfitReview'
import {
  monthMetrics, pickBaseline, deltasVsBaseline, fuelSplit, findings, projectProfit, breakEvenRatePerMile, rateLadder,
  type ReviewMonthInput, type MonthMetrics,
} from '@/lib/profitReview'
import { LOCAL_SUBGROUP_LABELS, type LocalSubgroup } from '@/lib/localSubgroups'

const usd0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const usd2 = (n: number | null | undefined) => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const num0 = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
const pct0 = (n: number | null | undefined) => n == null ? '—' : `${Math.round(n * 100)}%`
const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + usd0(Math.abs(n))

const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--ds-border)' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', borderBottom: '1px solid var(--ds-border)' }
const TDL: React.CSSProperties = { ...TD, textAlign: 'left', whiteSpace: 'normal' }
const GOOD = '#15803d', BAD = '#dc2626'
const tone = (n: number | null | undefined) => n == null ? 'var(--ds-t2)' : n > 0 ? GOOD : n < 0 ? BAD : 'var(--ds-t2)'

function Card({ title, icon, children, aside }: { title: string; icon?: React.ReactNode; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: '1px solid var(--ds-border)', flexWrap: 'wrap' }}>
        {icon && <span style={{ color: 'var(--ds-t3)', display: 'inline-flex' }}>{icon}</span>}
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', margin: 0, flex: 1 }}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}
const Note = ({ children }: { children: React.ReactNode }) => <p style={{ fontSize: 12, color: 'var(--ds-t3)', margin: 0, padding: '10px 18px', lineHeight: 1.5 }}>{children}</p>
const Wrap = ({ children }: { children: React.ReactNode }) => <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>{children}</table></div>

export function ProfitReviewPage() {
  const isMobile = useIsMobile()
  const [monthsBack, setMonthsBack] = useState(6)
  const [baselineKey, setBaselineKey] = useState<string>('auto')
  const { months, loading, error, unattributedFuel } = useProfitReview(monthsBack)

  const metrics = useMemo(() => new Map(months.map((m) => [m.key, monthMetrics(m)])), [months])
  const autoBaseline = useMemo(() => pickBaseline(months), [months])
  const baseline = months.find((m) => m.key === baselineKey) ?? autoBaseline
  const finished = months.filter((m) => m.daysElapsed >= m.daysInMonth && m.revenue > 0)
  const latest = finished[finished.length - 1] ?? null
  const current = months.find((m) => m.daysElapsed < m.daysInMonth && m.daysElapsed > 0) ?? null
  const found = useMemo(() => findings(months, baseline, { unattributedFuel }), [months, baseline, unattributedFuel])

  // Projection inputs default to the latest finished month.
  const ref = latest ?? baseline
  const refM = ref ? metrics.get(ref.key) : undefined
  const [pMiles, setPMiles] = useState<number | null>(null)
  const [pFixed, setPFixed] = useState<number | null>(null)
  const [pVar, setPVar] = useState<number | null>(null)
  const [deadheadMiles, setDeadheadMiles] = useState(59)
  const proj = {
    miles: pMiles ?? ref?.miles ?? 0,
    fixedCost: pFixed ?? (ref ? ref.insurance + ref.fixed : 0),
    variableCostPerMile: pVar ?? refM?.variableCostPerMile ?? 0,
  }
  const breakEven = breakEvenRatePerMile(proj)
  const rows = projectProfit(proj, ladderWith(breakEven, refM?.revPerMile ?? null))

  const pad = isMobile ? '16px 12px' : '24px 32px'

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: pad, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <Link to="/finances" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ds-t3)', textDecoration: 'none', marginBottom: 6 }}><ArrowLeft size={12} /> Finances</Link>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Profit Review — Ivan Local</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>Month over month: what moved profit, why, and what to change. Updates as loads, fuel, pay and invoices come in.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Window
              <select id="pr-window" value={monthsBack} onChange={(e) => setMonthsBack(Number(e.target.value))} style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t1)' }}>
                {[3, 6, 9, 12].map((n) => <option key={n} value={n}>{n} months</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Baseline
              <select id="pr-baseline" value={baselineKey} onChange={(e) => setBaselineKey(e.target.value)} style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t1)' }}>
                <option value="auto">Best month{autoBaseline ? ` (${autoBaseline.label})` : ''}</option>
                {finished.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {error && <div style={{ padding: '10px 14px', borderRadius: 8, background: '#fef2f2', color: BAD, fontSize: 13 }}>{error}</div>}
        {loading && months.every((m) => m.revenue === 0) && <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>}

        {/* Headline tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
          <Tile label={baseline ? `Baseline · ${baseline.label}` : 'Baseline'} value={baseline ? usd0(metrics.get(baseline.key)!.net) : '—'} sub={baseline ? `${pct0(metrics.get(baseline.key)!.margin)} margin · ${usd2(metrics.get(baseline.key)!.revPerMile)}/mi` : 'No finished month yet'} color={baseline ? tone(metrics.get(baseline.key)!.net) : undefined} />
          <Tile label={latest ? `Latest full month · ${latest.label}` : 'Latest full month'} value={latest ? usd0(metrics.get(latest.key)!.net) : '—'} sub={latest && baseline && latest.key !== baseline.key ? `${signed(metrics.get(latest.key)!.net - metrics.get(baseline.key)!.net)} vs ${baseline.label}` : latest ? `${pct0(metrics.get(latest.key)!.margin)} margin` : ''} color={latest ? tone(metrics.get(latest.key)!.net) : undefined} />
          <Tile label={current ? `${current.label} to date (day ${current.daysElapsed} of ${current.daysInMonth})` : 'This month'} value={current ? usd0(metrics.get(current.key)!.proratedNet) : '—'} sub={current ? `${pct0(metrics.get(current.key)!.proratedMargin)} margin with fixed costs prorated · ${usd0(metrics.get(current.key)!.net)} against the full month's fixed costs` : ''} color={current ? tone(metrics.get(current.key)!.proratedNet) : undefined} />
        </div>

        {/* What to change */}
        <Card title="What to change, ranked by dollars" icon={<ListChecks size={15} />}>
          {found.length === 0 ? <Note>Nothing stands out against the baseline. Costs, rate per mile and driver pay are all inside their normal range.</Note> : (
            <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {found.map((f, i) => (
                <li key={f.title} style={{ display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 12, padding: '12px 18px', borderBottom: i < found.length - 1 ? '1px solid var(--ds-border)' : undefined, alignItems: 'start' }}>
                  <span style={{ fontSize: 20, fontWeight: 700, color: f.severity === 'high' ? BAD : f.severity === 'medium' ? '#b45309' : 'var(--ds-t3)', lineHeight: 1.1 }}>{i + 1}</span>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>{f.title}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--ds-t2)', marginTop: 3, lineHeight: 1.5 }}>{f.detail}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{usd0(f.impact)}<div style={{ fontSize: 10, fontWeight: 500, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>a month</div></div>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {/* Monthly P&L */}
        <Card title="Monthly P&L" icon={<TrendingUp size={15} />}>
          <Wrap>
            <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Line</th>{months.map((m) => <th key={m.key} style={{ ...TH, background: baseline?.key === m.key ? 'var(--ds-bg)' : undefined }}>{m.label}{m.daysElapsed < m.daysInMonth ? ' (to date)' : ''}{baseline?.key === m.key ? ' · baseline' : ''}</th>)}</tr></thead>
            <tbody>
              <LineRow label="Revenue" months={months} get={(m) => m.revenue} bold />
              <LineRow label="Fuel" months={months} get={(m) => m.fuel} />
              <LineRow label="Driver pay" months={months} get={(m) => m.driverPay} />
              <LineRow label="Maintenance (trucks + trailers)" months={months} get={(m) => m.maintenance} />
              <LineRow label="Insurance" months={months} get={(m) => m.insurance} />
              <LineRow label="Fixed: loans, trailer lease, yard, tolls, ELD, permits, other" months={months} get={(m) => m.fixed} />
              <LineRow label="Total expenses" months={months} get={(m) => metrics.get(m.key)!.totalCost} bold />
              <tr><td style={{ ...TDL, fontWeight: 700 }}>Net profit</td>{months.map((m) => <td key={m.key} style={{ ...TD, fontWeight: 700, color: tone(metrics.get(m.key)!.net) }}>{usd0(metrics.get(m.key)!.net)}</td>)}</tr>
              <tr><td style={TDL}>Margin</td>{months.map((m) => <td key={m.key} style={TD}>{pct0(metrics.get(m.key)!.margin)}</td>)}</tr>
            </tbody>
          </Wrap>
          {current && <Note>{current.label} shows {current.daysElapsed} days of revenue against the full month's insurance and fixed costs. Prorated, it is running at {usd0(metrics.get(current.key)!.proratedNet)}.</Note>}
        </Card>

        {/* Baseline deltas */}
        {baseline && (
          <Card title={`Compared with ${baseline.label}: what each line did to profit`} icon={<TrendingUp size={15} />}>
            <Wrap>
              <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Line</th>{months.filter((m) => m.key !== baseline.key && m.daysElapsed >= m.daysInMonth).map((m) => <th key={m.key} style={TH}>{m.label}</th>)}</tr></thead>
              <tbody>
                {(['revenue', 'fuel', 'driverPay', 'maintenance', 'insurance', 'fixed', 'net'] as const).map((key) => {
                  const cols = months.filter((m) => m.key !== baseline.key && m.daysElapsed >= m.daysInMonth)
                  const maxAbs = Math.max(1, ...cols.map((m) => Math.abs(deltasVsBaseline(m, baseline).find((d) => d.key === key)!.effect)))
                  return (
                    <tr key={key}>
                      <td style={{ ...TDL, fontWeight: key === 'net' ? 700 : 500 }}>{deltasVsBaseline(baseline, baseline).find((d) => d.key === key)!.label}</td>
                      {cols.map((m) => {
                        const d = deltasVsBaseline(m, baseline).find((x) => x.key === key)!
                        const w = key === 'net' ? 0 : Math.round((Math.abs(d.effect) / maxAbs) * 70)
                        return (
                          <td key={m.key} style={{ ...TD, fontWeight: key === 'net' ? 700 : 500, color: tone(d.effect) }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                              {w > 0 && <span style={{ display: 'inline-block', height: 8, width: w, background: d.effect >= 0 ? GOOD : BAD, opacity: 0.6, borderRadius: 2 }} />}
                              {signed(d.effect)}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </Wrap>
            <Note>Positive is money that helped profit relative to the baseline (more revenue, or a cost that came in lower); negative hurt it. The baseline is the best finished month unless you pick another.</Note>
          </Card>
        )}

        {/* Per mile */}
        <Card title="Per mile and per load" icon={<Calculator size={15} />}>
          <Wrap>
            <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Fleet</th>{months.map((m) => <th key={m.key} style={TH}>{m.label}</th>)}</tr></thead>
            <tbody>
              <LineRow label="Miles (Motive)" months={months} get={(m) => m.miles} fmt={num0} />
              <LineRow label="Loads delivered" months={months} get={(m) => m.loads} fmt={num0} />
              <MetricRow label="Revenue per mile" months={months} metrics={metrics} get={(x) => x.revPerMile} />
              <MetricRow label="Revenue per load" months={months} metrics={metrics} get={(x) => x.revPerLoad} fmt={(n) => usd0(n)} />
              <MetricRow label="Fuel per mile" months={months} metrics={metrics} get={(x) => x.fuelPerMile} />
              <MetricRow label="Driver pay per mile" months={months} metrics={metrics} get={(x) => x.payPerMile} />
              <MetricRow label="Maintenance per mile" months={months} metrics={metrics} get={(x) => x.maintPerMile} />
              <MetricRow label="Insurance + fixed per mile" months={months} metrics={metrics} get={(x) => x.fixedPerMile} />
              <MetricRow label="All-in cost per mile" months={months} metrics={metrics} get={(x) => x.costPerMile} bold />
              <MetricRow label="Profit per mile" months={months} metrics={metrics} get={(x) => x.profitPerMile} bold colored />
              <MetricRow label="All-in cost per load" months={months} metrics={metrics} get={(x) => x.costPerLoad} fmt={(n) => usd0(n)} />
            </tbody>
          </Wrap>
          <Note>A load has to clear the all-in cost per mile (or per load) before it adds anything. Miles are Motive ELD miles for trucks that report them; a truck without Motive miles still contributes revenue, so per-mile figures lean slightly high.</Note>
        </Card>

        {/* Fuel */}
        <Card title="Fuel" icon={<Fuel size={15} />}>
          <Wrap>
            <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Diesel</th>{months.map((m) => <th key={m.key} style={TH}>{m.label}</th>)}</tr></thead>
            <tbody>
              <LineRow label="Gallons" months={months} get={(m) => m.gallons} fmt={num0} />
              <MetricRow label="Average price per gallon" months={months} metrics={metrics} get={(x) => x.pricePerGallon} />
              <LineRow label="Diesel spend" months={months} get={(m) => m.fuel} />
              <MetricRow label="Fleet miles per gallon" months={months} metrics={metrics} get={(x) => x.mpg} fmt={(n) => n.toFixed(1)} />
              {baseline && (
                <>
                  <tr><td style={TDL}>Price effect vs {baseline.label}</td>{months.map((m) => { const s = m.key === baseline.key ? null : fuelSplit(m, baseline); return <td key={m.key} style={{ ...TD, color: s ? tone(-s.priceEffect) : 'var(--ds-t3)' }}>{s ? signed(-s.priceEffect) : '—'}</td> })}</tr>
                  <tr><td style={TDL}>Volume effect vs {baseline.label}</td>{months.map((m) => { const s = m.key === baseline.key ? null : fuelSplit(m, baseline); return <td key={m.key} style={{ ...TD, color: s ? tone(-s.volumeEffect) : 'var(--ds-t3)' }}>{s ? signed(-s.volumeEffect) : '—'}</td> })}</tr>
                </>
              )}
            </tbody>
          </Wrap>
          {ref && (
            <>
              <div style={{ padding: '10px 18px 0', fontSize: 12, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{ref.label} by group</div>
              <Wrap>
                <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Group</th><th style={{ ...TH, textAlign: 'left' }}>Trucks</th><th style={TH}>Revenue</th><th style={TH}>Miles</th><th style={TH}>Rev / mi</th><th style={TH}>Fuel</th><th style={TH}>Fuel / mi</th><th style={TH}>MPG</th></tr></thead>
                <tbody>
                  {(['IVAN_LOCAL', 'BOX_TRUCK'] as LocalSubgroup[]).map((b) => {
                    const ts = ref.trucks.filter((t) => t.bucket === b)
                    if (ts.length === 0) return null
                    const rev = ts.reduce((s, t) => s + t.revenue, 0), mi = ts.reduce((s, t) => s + t.miles, 0), fu = ts.reduce((s, t) => s + t.fuel, 0)
                    const eco = ts.filter((t) => t.miles > 0 && t.gallons > 0)
                    const em = eco.reduce((s, t) => s + t.miles, 0), eg = eco.reduce((s, t) => s + t.gallons, 0)
                    return (
                      <tr key={b}>
                        <td style={{ ...TDL, fontWeight: 600 }}>{LOCAL_SUBGROUP_LABELS[b]}</td>
                        <td style={{ ...TDL, color: 'var(--ds-t3)', fontFamily: 'monospace', fontSize: 12 }}>{ts.map((t) => `#${t.unitNumber}`).join('  ')}</td>
                        <td style={TD}>{usd0(rev)}</td><td style={TD}>{num0(mi)}</td><td style={TD}>{usd2(mi > 0 ? rev / mi : null)}</td>
                        <td style={TD}>{usd0(fu)}</td><td style={TD}>{usd2(mi > 0 ? fu / mi : null)}</td><td style={TD}>{eg > 0 ? (em / eg).toFixed(1) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </Wrap>
              <div style={{ padding: '10px 18px 0', fontSize: 12, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{ref.label} fuel economy by truck</div>
              <Wrap>
                <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Truck</th><th style={TH}>Miles</th><th style={TH}>Gallons</th><th style={TH}>MPG</th><th style={TH}>Fuel / mi</th></tr></thead>
                <tbody>
                  {[...ref.trucks].sort((a, b) => (b.miles > 0 ? b.fuel / b.miles : -1) - (a.miles > 0 ? a.fuel / a.miles : -1)).map((t) => (
                    <tr key={t.unitNumber}>
                      <td style={TDL}><span style={{ fontFamily: 'monospace', fontWeight: 700 }}>#{t.unitNumber}</span> <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{LOCAL_SUBGROUP_LABELS[t.bucket]}</span></td>
                      <td style={TD}>{num0(t.miles)}</td><td style={TD}>{num0(t.gallons)}</td>
                      <td style={TD}>{t.miles > 0 && t.gallons > 0 ? (t.miles / t.gallons).toFixed(1) : '—'}</td>
                      <td style={TD}>{usd2(t.miles > 0 ? t.fuel / t.miles : null)}</td>
                    </tr>
                  ))}
                </tbody>
              </Wrap>
            </>
          )}
        </Card>

        {/* Driver pay */}
        <Card title="Driver pay" icon={<Users size={15} />}>
          <Wrap>
            <thead><tr><th style={{ ...TH, textAlign: 'left' }}></th>{months.map((m) => <th key={m.key} style={TH}>{m.label}</th>)}</tr></thead>
            <tbody>
              <LineRow label="Driver pay" months={months} get={(m) => m.driverPay} />
              <MetricRow label="Share of revenue" months={months} metrics={metrics} get={(x) => x.payShare} fmt={(n) => pct0(n)} />
              <tr><td style={TDL}>Revenue per $1 of pay</td>{months.map((m) => <td key={m.key} style={TD}>{m.driverPay > 0 ? usd2(m.revenue / m.driverPay) : '—'}</td>)}</tr>
            </tbody>
          </Wrap>
          <Note>Pay is the combined 14-day pay periods prorated to the month. When the share climbs past 28% the fleet is paying for hours that are not turning into loads.</Note>
        </Card>

        {/* Maintenance */}
        <Card title="Maintenance by unit" icon={<Wrench size={15} />}>
          <Wrap>
            <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Unit</th>{months.map((m) => <th key={m.key} style={TH}>{m.label}</th>)}<th style={TH}>Total</th><th style={{ ...TH, textAlign: 'left' }}>Biggest job in {ref?.label ?? 'window'}</th></tr></thead>
            <tbody>
              {(() => {
                const units = new Map<string, number>()
                for (const m of months) for (const u of m.unitMaintenance) units.set(u.unitNumber, (units.get(u.unitNumber) ?? 0) + u.amount)
                return [...units.entries()].sort((a, b) => b[1] - a[1]).map(([unit, total]) => {
                  const big = ref?.unitMaintenance.find((u) => u.unitNumber === unit)?.biggest
                  return (
                    <tr key={unit}>
                      <td style={{ ...TDL, fontFamily: 'monospace', fontWeight: 700 }}>#{unit}</td>
                      {months.map((m) => { const v = m.unitMaintenance.find((u) => u.unitNumber === unit)?.amount ?? 0; return <td key={m.key} style={{ ...TD, color: v === 0 ? 'var(--ds-t3)' : 'var(--ds-t1)' }}>{v === 0 ? '—' : usd0(v)}</td> })}
                      <td style={{ ...TD, fontWeight: 700 }}>{usd0(total)}</td>
                      <td style={{ ...TDL, fontSize: 12, color: 'var(--ds-t2)' }}>{big ? `${big.description} · ${usd0(big.amount)}` : '—'}</td>
                    </tr>
                  )
                })
              })()}
              <tr><td style={{ ...TDL, fontWeight: 700 }}>Total</td>{months.map((m) => <td key={m.key} style={{ ...TD, fontWeight: 700 }}>{usd0(m.maintenance)}</td>)}<td style={{ ...TD, fontWeight: 700 }}>{usd0(months.reduce((s, m) => s + m.maintenance, 0))}</td><td style={TD}></td></tr>
            </tbody>
          </Wrap>
          <Note>Posted invoices on Ivan Local trucks plus all trailers, the same rule as the Monthly P&L maintenance line.</Note>
        </Card>

        {/* Load mix */}
        <Card title="Revenue and load mix" icon={<Package size={15} />}>
          <Wrap>
            <thead><tr><th style={{ ...TH, textAlign: 'left' }}></th>{months.map((m) => <th key={m.key} style={TH}>{m.label}</th>)}</tr></thead>
            <tbody>
              <LineRow label="Loads" months={months} get={(m) => m.loads} fmt={num0} />
              <MetricRow label="Revenue per load" months={months} metrics={metrics} get={(x) => x.revPerLoad} fmt={(n) => usd0(n)} />
              <MetricRow label="All-in cost per load" months={months} metrics={metrics} get={(x) => x.costPerLoad} fmt={(n) => usd0(n)} />
            </tbody>
          </Wrap>
          {ref && (
            <>
              <div style={{ padding: '10px 18px 0', fontSize: 12, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{ref.label} by customer</div>
              <Wrap>
                <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Customer</th><th style={TH}>Loads</th><th style={TH}>Revenue</th><th style={TH}>Avg per load</th><th style={TH}>vs cost per load</th></tr></thead>
                <tbody>
                  {ref.customers.slice(0, 12).map((c) => {
                    const avg = c.revenue / c.loads
                    const cpl = refM?.costPerLoad ?? null
                    const diff = cpl == null ? null : avg - cpl
                    return (
                      <tr key={c.name}>
                        <td style={TDL}>{c.name}</td><td style={TD}>{c.loads}</td><td style={TD}>{usd0(c.revenue)}</td><td style={TD}>{usd0(avg)}</td>
                        <td style={{ ...TD, color: tone(diff), fontWeight: 600 }}>{diff == null ? '—' : signed(diff)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </Wrap>
              <Note>Customers whose average is below the all-in cost per load are being carried by the rest of the month. Three or more loads below cost shows up in the list at the top of the page.</Note>
            </>
          )}
        </Card>

        {/* Projections */}
        <Card title="Profit at different rates per mile" icon={<Calculator size={15} />}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--ds-border)' }}>
            <Field id="pr-miles" label="Miles a month" value={proj.miles} onChange={setPMiles} step={500} hint={ref ? `${ref.label}: ${num0(ref.miles)}` : ''} />
            <Field id="pr-fixed" label="Fixed costs a month (insurance + fixed lines)" value={proj.fixedCost} onChange={setPFixed} step={100} prefix="$" hint={ref ? `${ref.label}: ${usd0(ref.insurance + ref.fixed)}` : ''} />
            <Field id="pr-var" label="Variable cost per mile (fuel + pay + maintenance)" value={proj.variableCostPerMile} onChange={setPVar} step={0.05} prefix="$" decimals={2} hint={refM?.variableCostPerMile != null ? `${ref!.label}: ${usd2(refM.variableCostPerMile)}` : ''} />
          </div>
          <Wrap>
            <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Average rate per mile</th><th style={TH}>Revenue</th><th style={TH}>Variable cost</th><th style={TH}>Fixed cost</th><th style={TH}>Net profit</th><th style={TH}>Margin</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const isBE = breakEven != null && Math.abs(r.ratePerMile - breakEven) < 0.005
                const isNow = refM?.revPerMile != null && Math.abs(r.ratePerMile - refM.revPerMile) < 0.005
                return (
                  <tr key={r.ratePerMile} style={{ background: isBE || isNow ? 'var(--ds-bg)' : undefined }}>
                    <td style={{ ...TDL, fontWeight: 600 }}>{usd2(r.ratePerMile)}{isBE && <Tag text="break-even" />}{isNow && ref && <Tag text={`${ref.label} actual`} />}</td>
                    <td style={TD}>{usd0(r.revenue)}</td><td style={TD}>{usd0(r.variableCost)}</td><td style={TD}>{usd0(r.fixedCost)}</td>
                    <td style={{ ...TD, fontWeight: 700, color: tone(r.net) }}>{usd0(r.net)}</td><td style={{ ...TD, color: tone(r.net) }}>{pct0(r.margin)}</td>
                  </tr>
                )
              })}
            </tbody>
          </Wrap>
          <Note>Break-even is the variable cost per mile plus fixed costs spread over the miles: {breakEven != null ? usd2(breakEven) : '—'} at these inputs. Every $0.25 a mile above it is worth {usd0(0.25 * proj.miles)} a month at {num0(proj.miles)} miles.</Note>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderTop: '1px solid var(--ds-border)', flexWrap: 'wrap' }}>
            <Field id="pr-deadhead" label="Cost of a deadhead (miles; yard to Batory Chicago is 59)" value={deadheadMiles} onChange={(n) => setDeadheadMiles(n ?? 0)} step={5} compact />
            <div style={{ fontSize: 13, color: 'var(--ds-t1)' }}>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{usd0(deadheadMiles * proj.variableCostPerMile)}</strong> one way at {usd2(proj.variableCostPerMile)}/mi
              {refM && <span style={{ color: 'var(--ds-t3)' }}> · fuel {usd0(deadheadMiles * (refM.fuelPerMile ?? 0))}, driver {usd0(deadheadMiles * (refM.payPerMile ?? 0))}, wear {usd0(deadheadMiles * (refM.maintPerMile ?? 0))}</span>}
              <span style={{ color: 'var(--ds-t3)' }}> · plus {usd0(deadheadMiles * (refM?.revPerMile ?? 0))} of revenue those miles could have earned</span>
            </div>
          </div>
        </Card>

        {unattributedFuel.count > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px' }}>
            <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{unattributedFuel.count} fuel purchases ({usd0(unattributedFuel.amount)}) in this window have no truck on file and are left out. Add the card number to the truck in Fleet.</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** $2.50–$5.00 in quarter steps, plus the break-even and actual rates so both get a row. */
function ladderWith(breakEven: number | null, actual: number | null): number[] {
  const base = rateLadder(2.5, 5, 0.25)
  for (const extra of [breakEven, actual]) {
    if (extra != null && !base.some((r) => Math.abs(r - extra) < 0.005)) base.push(Math.round(extra * 100) / 100)
  }
  return base.sort((a, b) => a - b)
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color ?? 'var(--ds-t1)', marginTop: 4, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function Tag({ text }: { text: string }) {
  return <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ds-t2)', border: '1px solid var(--ds-border)', borderRadius: 4, padding: '1px 5px' }}>{text}</span>
}

function LineRow({ label, months, get, fmt = usd0, bold }: { label: string; months: ReviewMonthInput[]; get: (m: ReviewMonthInput) => number; fmt?: (n: number) => string; bold?: boolean }) {
  return <tr><td style={{ ...TDL, fontWeight: bold ? 700 : 500 }}>{label}</td>{months.map((m) => <td key={m.key} style={{ ...TD, fontWeight: bold ? 700 : 500 }}>{fmt(get(m))}</td>)}</tr>
}

function MetricRow({ label, months, metrics, get, fmt = (n) => usd2(n), bold, colored }: { label: string; months: ReviewMonthInput[]; metrics: Map<string, MonthMetrics>; get: (x: MonthMetrics) => number | null; fmt?: (n: number) => string; bold?: boolean; colored?: boolean }) {
  return (
    <tr>
      <td style={{ ...TDL, fontWeight: bold ? 700 : 500 }}>{label}</td>
      {months.map((m) => { const v = get(metrics.get(m.key)!); return <td key={m.key} style={{ ...TD, fontWeight: bold ? 700 : 500, color: v == null ? 'var(--ds-t3)' : colored ? tone(v) : 'var(--ds-t1)' }}>{v == null ? '—' : fmt(v)}</td> })}
    </tr>
  )
}

function Field({ id, label, value, onChange, step, prefix, decimals = 0, hint, compact }: { id: string; label: string; value: number; onChange: (n: number | null) => void; step: number; prefix?: string; decimals?: number; hint?: string; compact?: boolean }) {
  return (
    <label htmlFor={id} style={{ display: 'flex', flexDirection: compact ? 'row' : 'column', gap: compact ? 8 : 4, alignItems: compact ? 'center' : 'stretch', fontSize: 12, color: 'var(--ds-t3)' }}>
      <span>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {prefix && <span style={{ color: 'var(--ds-t3)' }}>{prefix}</span>}
        <input id={id} type="number" step={step} value={Number(value.toFixed(decimals))} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          style={{ width: compact ? 90 : '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }} />
      </span>
      {hint && <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{hint}</span>}
    </label>
  )
}
