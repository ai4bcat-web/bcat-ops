import { useMemo, useState } from 'react'
import { Truck } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MoneyCell } from '@/components/ui/table-cells'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTruckOdometer, type TruckMilesWeek } from '@/hooks/useTruckOdometer'
import { addDays, recentWeekStarts } from '@/lib/odometerWeek'

/** Local today, YYYY-MM-DD (week selector only needs a date, not a timezone). */
function todayIso(): string {
  const n = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
}

function shortDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
}

function prettyWeek(weekStart: string): string {
  return `${shortDate(weekStart)} – ${shortDate(addDays(weekStart, 6))}`
}

function fmtMiles(m: number | null | undefined): string {
  return m == null ? '—' : Math.round(m).toLocaleString('en-US')
}

function fmtMpg(m: number | null | undefined): string {
  return m == null ? '—' : m.toFixed(1)
}

function fmtRate(r: number | null | undefined): string {
  return r == null ? '—' : `$${r.toFixed(2)}`
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '14px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ds-t1)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

/**
 * Fleet Miles — per-truck weekly odometer ledger from Motive: miles driven each
 * day, Motive's MPG for the day and the week, and revenue per mile.
 */
export function FleetMilesPage() {
  const isMobile = useIsMobile()
  const [weekStart, setWeekStart] = useState(() => recentWeekStarts(1, todayIso())[0])
  const weeks = useMemo(() => recentWeekStarts(16, todayIso()), [])
  const { trucks, loading, error } = useTruckOdometer(weekStart)

  const totals = useMemo(() => {
    const miles = trucks.reduce((sum, t) => sum + t.totalMiles, 0)
    const fuel = trucks.reduce((sum, t) => sum + (t.totalFuelGallons ?? 0), 0)
    const revenue = trucks.reduce((sum, t) => sum + t.revenue, 0)
    return {
      miles,
      revenue,
      mpg: miles > 0 && fuel > 0 ? miles / fuel : null,
      revenuePerMile: miles > 0 ? revenue / miles : null,
    }
  }, [trucks])

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, color: 'var(--ds-t1)', letterSpacing: '-0.01em' }}>Fleet Miles</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
              Daily miles, Motive MPG and revenue per mile · week of {prettyWeek(weekStart)}
            </p>
          </div>
          <div style={{ width: 230 }}>
            <Select value={weekStart} onValueChange={setWeekStart}>
              <SelectTrigger aria-label="Week"><SelectValue /></SelectTrigger>
              <SelectContent>
                {weeks.map((w) => (
                  <SelectItem key={w} value={w}>{prettyWeek(w)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          <Kpi label="Week Miles"      value={fmtMiles(totals.miles)} />
          <Kpi label="Week MPG"        value={fmtMpg(totals.mpg)} sub="from Motive fuel" />
          <Kpi label="Week Revenue"    value={fmtRate(totals.revenue)} />
          <Kpi label="Revenue / Mile"  value={fmtRate(totals.revenuePerMile)} />
        </div>

        {error && (
          <div style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '10px 14px', fontSize: 13 }}>
            Could not load odometer data: {error}
          </div>
        )}

        <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>Loading…</div>
          ) : trucks.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <Truck size={22} style={{ opacity: 0.35 }} />
              No trucks in the fleet registry
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Truck</TableHead>
                  {trucks[0].days.map((d) => (
                    <TableHead key={d.date} className="text-right">
                      <div>{d.label}</div>
                      <div className="text-[10px] font-normal text-muted-foreground">{shortDate(d.date)}</div>
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Week</TableHead>
                  <TableHead className="text-right">Week MPG</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Rev / Mile</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trucks.map((t) => <TruckRow key={t.truckId} truck={t} />)}
              </TableBody>
            </Table>
          )}
        </div>

        <p style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
          Miles are odometer deltas from Motive (a backwards reading counts as 0); MPG is Motive driving
          fuel; revenue is the week's delivered loads at the delivery driver's truck.
        </p>
      </div>
    </div>
  )
}

function TruckRow({ truck }: { truck: TruckMilesWeek }) {
  return (
    <TableRow>
      <TableCell className="font-semibold">{truck.unitNumber}</TableCell>
      {truck.days.map((d) => (
        <TableCell key={d.date} className="text-right">
          <div className="font-mono text-[13px] tabular-nums">{fmtMiles(d.miles)}</div>
          <div className="text-[10.5px] text-muted-foreground">{d.mpg == null ? '' : `${fmtMpg(d.mpg)} mpg`}</div>
        </TableCell>
      ))}
      <TableCell className="text-right font-mono text-[13px] font-semibold tabular-nums">{fmtMiles(truck.totalMiles)}</TableCell>
      <TableCell className="text-right font-mono text-[13px] tabular-nums">{fmtMpg(truck.mpg)}</TableCell>
      <TableCell className="text-right"><MoneyCell value={truck.revenue} /></TableCell>
      <TableCell className="text-right font-mono text-[13px] tabular-nums">{fmtRate(truck.revenuePerMile)}</TableCell>
    </TableRow>
  )
}
