import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  Umbrella, Truck, Container, HeartPulse, Plus, ArrowLeftRight, Trash2, Star, CopyPlus,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { KpiCard } from '@/components/ui/kpi-card'
import { useInsurance, type UnitRow } from '@/hooks/useInsurance'
import { useInsuranceRecovery } from '@/hooks/useInsuranceRecovery'
import { useExpenseData } from '@/hooks/useExpenseData'
import { useTrucks } from '@/hooks/useTrucks'
import { legacyTruckInsuranceCents } from '@/lib/truckCosts'
import { importLegacyTruckPremiums } from '@/lib/insuranceClient'

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (cents: number, dec = false) => (dec ? usd2 : usd0).format((cents || 0) / 100)

const cardStyle: CSSProperties = { background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }
const inputStyle: CSSProperties = { borderRadius: 7, border: '1px solid var(--ds-border)', padding: '7px 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', outline: 'none', width: 120, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const thStyle: CSSProperties = { padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }
const tdStyle: CSSProperties = { padding: '9px 16px', color: 'var(--ds-t2)', fontSize: 13 }

/** Dollar input that commits cents on blur / Enter. */
function MoneyInput({ cents, onCommit, disabled }: { cents: number; onCommit: (cents: number) => void; disabled?: boolean }) {
  const [raw, setRaw] = useState(cents ? String(cents / 100) : '')
  useEffect(() => { setRaw(cents ? String(cents / 100) : '') }, [cents])
  const commit = () => {
    const dollars = parseFloat(raw.replace(/[^0-9.]/g, ''))
    const c = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0
    if (c !== cents) onCommit(c)
  }
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span style={{ position: 'absolute', left: 10, color: 'var(--ds-t3)', fontSize: 13, pointerEvents: 'none' }}>$</span>
      <input
        value={raw} onChange={(e) => setRaw(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        inputMode="decimal" placeholder="0" disabled={disabled}
        style={{ ...inputStyle, paddingLeft: 18 }}
      />
    </div>
  )
}

function Card({ title, sub, right, children }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={cardStyle}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</div>
          {sub && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>{sub}</div>}
        </div>
        {right && <div style={{ flexShrink: 0 }}>{right}</div>}
      </div>
      {children}
    </div>
  )
}

export function InsurancePage() {
  const ins = useInsurance()
  const recovery = useInsuranceRecovery()
  const expenseData = useExpenseData()
  const { equipment } = useTrucks()
  const [mode, setMode] = useState<'edit' | 'compare'>('edit')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cmpA, setCmpA] = useState<string | null>(null)
  const [cmpB, setCmpB] = useState<string | null>(null)

  // Default the working period to the current one once loaded.
  useEffect(() => {
    if (!selectedId && ins.currentPeriod) setSelectedId(ins.currentPeriod.id)
  }, [ins.currentPeriod, selectedId])
  // Default compare to (previous vs current).
  useEffect(() => {
    if (ins.periods.length >= 1 && !cmpB) setCmpB(ins.currentPeriod?.id ?? ins.periods[0].id)
    if (ins.periods.length >= 2 && !cmpA) {
      const others = ins.periods.filter((p) => p.id !== (ins.currentPeriod?.id ?? ins.periods[0].id))
      setCmpA(others[0]?.id ?? null)
    }
  }, [ins.periods, ins.currentPeriod, cmpA, cmpB])

  const period = ins.periods.find((p) => p.id === selectedId) ?? ins.currentPeriod
  const totals = useMemo(() => (period ? ins.summary(period.id) : null), [period, ins])
  const truckRows = useMemo(() => (period ? ins.unitRows(period.id, 'TRUCK') : []), [period, ins])
  const trailerRows = useMemo(() => (period ? ins.unitRows(period.id, 'TRAILER') : []), [period, ins])
  const wc = period ? ins.wcItem(period.id) : null

  async function newPeriod() {
    const label = window.prompt('Name this insurance period (e.g. "2026 Policy Year"):')?.trim()
    if (!label) return
    try { const p = await ins.addPeriod(label, { makeCurrent: ins.periods.length === 0 }); setSelectedId(p.id); toast.success(`Created "${label}"`) }
    catch (e) { console.error(e); toast.error('Could not create period') }
  }
  async function clonePeriod() {
    if (!period) return
    const label = window.prompt(`Start a new period pre-filled from "${period.label}". Name it:`)?.trim()
    if (!label) return
    try { const p = await ins.startPeriodFrom(period.id, label); setSelectedId(p.id); toast.success(`Created "${label}" from ${period.label}`) }
    catch (e) { console.error(e); toast.error('Could not clone period') }
  }
  async function makeCurrent() {
    if (!period) return
    try { await ins.makeCurrent(period.id); toast.success(`"${period.label}" is now the current period`) }
    catch (e) { console.error(e); toast.error('Could not update') }
  }
  async function removePeriod() {
    if (!period) return
    if (!window.confirm(`Delete "${period.label}" and all its insurance amounts? This cannot be undone.`)) return
    try { await ins.removePeriod(period.id); setSelectedId(null); toast.success('Period deleted') }
    catch (e) { console.error(e); toast.error('Could not delete') }
  }

  // Legacy per-truck insurance entered on truck profiles before this module existed.
  const legacyPairs = useMemo(
    () => legacyTruckInsuranceCents(
      expenseData.recurring, expenseData.allocations, expenseData.expenseTypes,
      equipment.filter((e) => e.type === 'truck').map((e) => ({ id: e.id, unitNumber: e.unitNumber })),
    ),
    [expenseData.recurring, expenseData.allocations, expenseData.expenseTypes, equipment],
  )
  async function importLegacy() {
    try {
      const n = await importLegacyTruckPremiums(legacyPairs)
      await ins.refresh()
      toast.success(n > 0 ? `Imported ${n} truck premium${n === 1 ? '' : 's'} from truck profiles` : 'Nothing new to import')
    } catch (e) { console.error(e); toast.error('Import failed') }
  }

  const wrap: CSSProperties = { maxWidth: 1200, margin: '0 auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }

  if (!ins.loading && ins.periods.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div style={wrap}>
          <Header onNew={newPeriod} />
          <div style={{ ...cardStyle, padding: '40px 24px', textAlign: 'center' }}>
            <Umbrella size={30} style={{ color: 'var(--ds-blue)', margin: '0 auto 10px' }} />
            <div style={{ fontWeight: 600, color: 'var(--ds-t1)' }}>No insurance periods yet</div>
            <div style={{ fontSize: 13, color: 'var(--ds-t3)', marginTop: 4, maxWidth: 440, marginInline: 'auto' }}>
              Create a period (a policy term, e.g. “2026 Policy Year”), then enter each truck’s and trailer’s
              annual premium plus your workmans-comp total. Add a second period to compare year over year.
            </div>
            <Button style={{ marginTop: 16 }} onClick={newPeriod}><Plus size={15} /> Create first period</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div style={wrap}>
        <Header onNew={newPeriod} />

        <RecoveryCard recovery={recovery} grossAnnual={(totals?.totalCents ?? 0) / 100} />

        {/* Controls: period picker + mode toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', borderRadius: 9, border: '1px solid var(--ds-border)', overflow: 'hidden' }}>
            <button onClick={() => setMode('edit')} style={segStyle(mode === 'edit')}>Amounts</button>
            <button onClick={() => setMode('compare')} style={segStyle(mode === 'compare')}><ArrowLeftRight size={13} /> Compare</button>
          </div>
          {mode === 'edit' && period && (
            <>
              <select value={period.id} onChange={(e) => setSelectedId(e.target.value)} style={selectStyle}>
                {ins.periods.map((p) => <option key={p.id} value={p.id}>{p.label}{p.isCurrent ? ' • current' : ''}</option>)}
              </select>
              {!period.isCurrent && <Button size="sm" variant="outline" style={{ paddingInline: 16 }} onClick={makeCurrent}><Star size={14} /> Set current</Button>}
              <Button size="sm" variant="outline" style={{ paddingInline: 16 }} onClick={clonePeriod}><CopyPlus size={14} /> New from this</Button>
              {legacyPairs.length > 0 && <Button size="sm" variant="outline" style={{ paddingInline: 16 }} onClick={importLegacy} title="Import insurance values entered on truck profiles"><Truck size={14} /> Import from trucks</Button>}
              <Button size="sm" variant="ghost" style={{ paddingInline: 12, color: 'var(--ds-red)' }} onClick={removePeriod} title="Delete period"><Trash2 size={14} /></Button>
            </>
          )}
        </div>

        {mode === 'edit' && period && totals && (
          <EditView
            totals={totals} truckRows={truckRows} trailerRows={trailerRows} wcCents={wc?.annualCents ?? 0}
            isCurrent={!!period.isCurrent}
            onSetTruck={(r, c) => r.equipment && ins.setUnitAmount(period.id, 'TRUCK', r.equipment.id, r.unitNumber, c)}
            onSetTrailer={(r, c) => r.equipment && ins.setUnitAmount(period.id, 'TRAILER', r.equipment.id, r.unitNumber, c)}
            onSetWc={(c) => ins.setWcAmount(period.id, c)}
            onRemoveOrphan={(r) => r.item && ins.removeLineItem(r.item.id)}
          />
        )}

        {mode === 'compare' && (
          <CompareView ins={ins} a={cmpA} b={cmpB} setA={setCmpA} setB={setCmpB} />
        )}
      </div>
    </div>
  )
}

function RecoveryCard({ recovery, grossAnnual }: { recovery: ReturnType<typeof useInsuranceRecovery>; grossAnnual: number }) {
  const { amazonAnnual, boxTruckAnnual, totalAnnual, rows, loading } = recovery
  const net = Math.max(0, grossAnnual - totalAnnual)
  const pct = grossAnnual > 0 ? (totalAnnual / grossAnnual) * 100 : 0
  return (
    <div style={{ ...cardStyle, padding: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0 }}>
        <div style={{ padding: '16px 18px', borderRight: '1px solid var(--ds-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--ds-t3)' }}>
            <HeartPulse size={14} style={{ color: 'var(--ds-green)' }} /> Recovered from driver settlements
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ds-green)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{loading ? '…' : money(totalAnnual * 100)}<span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ds-t3)' }}> / yr</span></div>
          <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>
            {grossAnnual > 0 ? `${pct.toFixed(0)}% of premiums` : 'deducted from Amazon + box-truck pay'}
          </div>
        </div>
        <div style={{ padding: '16px 18px', borderRight: '1px solid var(--ds-border)' }}>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>By pay group</div>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span style={{ color: 'var(--ds-t2)' }}>Amazon drivers</span><span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{money(amazonAnnual * 100)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span style={{ color: 'var(--ds-t2)' }}>Box-truck drivers</span><span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{money(boxTruckAnnual * 100)}</span></div>
            <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 2 }}>{rows.length} driver{rows.length === 1 ? '' : 's'} carry an insurance line</div>
          </div>
        </div>
        <div style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Net company insurance</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ds-t1)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{money(net * 100)}<span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ds-t3)' }}> / yr</span></div>
          <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>premiums − recovered</div>
        </div>
      </div>
    </div>
  )
}

function Header({ onNew }: { onNew: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Insurance</h1>
        <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
          Annual premiums by truck, trailer, and workmans comp — with period-over-period comparison.
        </p>
      </div>
      <Button style={{ paddingInline: 20 }} onClick={onNew}><Plus size={15} /> New period</Button>
    </div>
  )
}

function EditView({
  totals, truckRows, trailerRows, wcCents, isCurrent, onSetTruck, onSetTrailer, onSetWc, onRemoveOrphan,
}: {
  totals: { truckCents: number; trailerCents: number; wcCents: number; totalCents: number }
  truckRows: UnitRow[]; trailerRows: UnitRow[]; wcCents: number; isCurrent: boolean
  onSetTruck: (r: UnitRow, cents: number) => void
  onSetTrailer: (r: UnitRow, cents: number) => void
  onSetWc: (cents: number) => void
  onRemoveOrphan: (r: UnitRow) => void
}) {
  const trucksPriced = truckRows.filter((r) => !r.orphaned && r.annualCents > 0).length
  const trailersPriced = trailerRows.filter((r) => !r.orphaned && r.annualCents > 0).length
  const trucksLive = truckRows.filter((r) => !r.orphaned).length
  const trailersLive = trailerRows.filter((r) => !r.orphaned).length

  return (
    <>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <KpiCard label={isCurrent ? 'Current insurance (annual)' : 'Total (annual)'} value={money(totals.totalCents)} sublabel={`${money(totals.totalCents / 12)} / mo`} icon={<Umbrella size={15} />} accent="#1ea8f3" />
        <KpiCard label="Trucks" value={money(totals.truckCents)} sublabel={`${trucksPriced} of ${trucksLive} priced`} icon={<Truck size={15} />} accent="#6d28d9" />
        <KpiCard label="Trailers" value={money(totals.trailerCents)} sublabel={`${trailersPriced} of ${trailersLive} priced`} icon={<Container size={15} />} accent="#6d28d9" />
        <KpiCard label="Workmans comp" value={money(totals.wcCents)} sublabel={`${money(totals.wcCents / 12)} / mo`} icon={<HeartPulse size={15} />} accent="#b45309" />
      </div>

      <UnitTable title="Truck insurance" sub="Annual premium allocated to each truck" rows={truckRows} totalCents={totals.truckCents} onSet={onSetTruck} onRemoveOrphan={onRemoveOrphan} />
      <UnitTable title="Trailer insurance" sub="Annual premium allocated to each trailer" rows={trailerRows} totalCents={totals.trailerCents} onSet={onSetTrailer} onRemoveOrphan={onRemoveOrphan} />

      {/* Workmans comp */}
      <Card title="Workmans comp" sub="Single annual total">
        <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Annual workmans-comp premium</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <MoneyInput cents={wcCents} onCommit={onSetWc} />
            <span style={{ fontSize: 12, color: 'var(--ds-t3)', width: 90, textAlign: 'right' }}>{money(wcCents / 12, true)} / mo</span>
          </div>
        </div>
      </Card>
    </>
  )
}

function UnitTable({
  title, sub, rows, totalCents, onSet, onRemoveOrphan,
}: {
  title: string; sub: string; rows: UnitRow[]; totalCents: number
  onSet: (r: UnitRow, cents: number) => void
  onRemoveOrphan: (r: UnitRow) => void
}) {
  return (
    <Card title={title} sub={sub}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              <th style={thStyle}>Unit</th>
              <th style={thStyle}>Make / Model</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Annual premium</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Monthly</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>% of premium</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ ...tdStyle, textAlign: 'center', padding: '24px 16px', color: 'var(--ds-t3)' }}>No units in the fleet.</td></tr>
            )}
            {rows.map((r) => {
              const pct = totalCents > 0 ? (r.annualCents / totalCents) * 100 : 0
              return (
                <tr key={r.key} style={{ borderBottom: '1px solid var(--ds-border)', opacity: r.orphaned ? 0.7 : 1 }}>
                  <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--ds-t1)' }}>
                    #{r.unitNumber}
                    {r.orphaned && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 600, color: 'var(--ds-amber)', background: 'var(--ds-amber-bg)', borderRadius: 999, padding: '1px 7px' }}>not in fleet</span>}
                  </td>
                  <td style={tdStyle}>{r.equipment ? `${r.equipment.make} ${r.equipment.model}${r.equipment.year ? ` · ${r.equipment.year}` : ''}` : '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {r.orphaned
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{money(r.annualCents, true)}<button onClick={() => onRemoveOrphan(r)} title="Remove line item" style={{ border: 'none', background: 'none', color: 'var(--ds-red)', cursor: 'pointer' }}><Trash2 size={13} /></button></span>
                      : <MoneyInput cents={r.annualCents} onCommit={(c) => onSet(r, c)} />}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t3)' }}>{money(r.annualCents / 12, true)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t3)' }}>{pct.toFixed(1)}%</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--ds-border)' }}>
              <td style={{ ...tdStyle, fontWeight: 700, color: 'var(--ds-t1)' }} colSpan={2}>Total</td>
              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: 'var(--ds-t1)' }}>{money(totalCents, true)}</td>
              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: 'var(--ds-t2)' }}>{money(totalCents / 12, true)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  )
}

function CompareView({
  ins, a, b, setA, setB,
}: {
  ins: ReturnType<typeof useInsurance>
  a: string | null; b: string | null
  setA: (id: string) => void; setB: (id: string) => void
}) {
  const pA = ins.periods.find((p) => p.id === a)
  const pB = ins.periods.find((p) => p.id === b)
  if (ins.periods.length < 2) {
    return <div style={{ ...cardStyle, padding: '32px 24px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>Add at least two periods to compare. Use “New from this” to carry amounts forward.</div>
  }
  if (!a || !b || !pA || !pB) return null
  const c = ins.compare(a, b)
  const rows: { label: string; d: typeof c.truck }[] = [
    { label: 'Trucks', d: c.truck }, { label: 'Trailers', d: c.trailer }, { label: 'Workmans comp', d: c.wc },
  ]

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <select value={a} onChange={(e) => setA(e.target.value)} style={selectStyle}>
          {ins.periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <ArrowLeftRight size={16} style={{ color: 'var(--ds-t3)' }} />
        <select value={b} onChange={(e) => setB(e.target.value)} style={selectStyle}>
          {ins.periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      {/* Headline total delta */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <KpiCard label={pA.label} value={money(c.total.a)} sublabel="annual total" accent="#94a3b8" />
        <KpiCard label={pB.label} value={money(c.total.b)} sublabel="annual total" accent="#1ea8f3" />
        <KpiCard label="Change" value={<DeltaText delta={c.total.delta} />} sublabel={c.total.pct === null ? '—' : `${c.total.pct >= 0 ? '+' : ''}${c.total.pct.toFixed(1)}%`} accent={c.total.delta > 0 ? '#b91c1c' : c.total.delta < 0 ? '#15803d' : '#94a3b8'} />
      </div>

      <Card title="By category" sub={`${pA.label} → ${pB.label}`}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <th style={thStyle}>Category</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>{pA.label}</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>{pB.label}</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Change</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--ds-t1)' }}>{r.label}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(r.d.a)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(r.d.b)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}><DeltaText delta={r.d.delta} /></td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t3)' }}>{r.d.pct === null ? '—' : `${r.d.pct >= 0 ? '+' : ''}${r.d.pct.toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--ds-border)' }}>
                <td style={{ ...tdStyle, fontWeight: 700, color: 'var(--ds-t1)' }}>Total</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{money(c.total.a)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{money(c.total.b)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}><DeltaText delta={c.total.delta} /></td>
                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: 'var(--ds-t3)' }}>{c.total.pct === null ? '—' : `${c.total.pct >= 0 ? '+' : ''}${c.total.pct.toFixed(1)}%`}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {c.units.length > 0 && (
        <Card title="By unit" sub="Biggest premium changes first">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <th style={thStyle}>Unit</th>
                  <th style={thStyle}>Type</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>{pA.label}</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>{pB.label}</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Change</th>
                </tr>
              </thead>
              <tbody>
                {c.units.map((u) => (
                  <tr key={u.key} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--ds-t1)' }}>#{u.unitNumber}</td>
                    <td style={tdStyle}>{u.kind === 'TRUCK' ? 'Truck' : 'Trailer'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.a ? money(u.a, true) : '—'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.b ? money(u.b, true) : '—'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}><DeltaText delta={u.delta} dec /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}

function DeltaText({ delta, dec }: { delta: number; dec?: boolean }) {
  if (delta === 0) return <span style={{ color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums' }}>—</span>
  const up = delta > 0
  return (
    <span style={{ color: up ? 'var(--ds-red)' : 'var(--ds-green)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
      {up ? '+' : '−'}{money(Math.abs(delta), dec)}
    </span>
  )
}

function segStyle(active: boolean): CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: active ? 'var(--ds-blue)' : 'var(--ds-surface)', color: active ? '#fff' : 'var(--ds-t2)' }
}
const selectStyle: CSSProperties = { borderRadius: 8, border: '1px solid var(--ds-border)', padding: '8px 12px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', outline: 'none', minWidth: 180 }
