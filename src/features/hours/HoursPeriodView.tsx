/**
 * The Employee Hours layout: a summary bar, one collapsible row per driver, a footer total.
 *
 * Presentational. The page loads the cards, the Motive windows and the rates, and decides who
 * may see pay; this lays them out. With `showPay` false there is no Rate column, no Pay column,
 * no rate editor and no dollar figure anywhere in the markup.
 */
import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Pencil, Printer, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { decimalHours, clockEdges, CLOCK_EDGE_TOLERANCE_MINUTES, minutesLabel, type DayTotal, type TruckDayWindow, type WeekTotal } from '@/lib/timeClock'
import { dayWarning, hm, totalsOf, type DriverHoursRow } from '@/lib/hoursView'
import { money } from '@/lib/hoursPay'

export interface DayEdit { id: string; hours: string; note: string }

/** Every column of a driver row, so the header, the rows and the footer line up. */
const COLS = 'grid grid-cols-[28px_minmax(150px,1.6fr)_repeat(4,minmax(70px,1fr))] items-center gap-x-3'
const PAY_COLS = 'grid grid-cols-[28px_minmax(150px,1.6fr)_repeat(4,minmax(70px,1fr))_minmax(90px,1fr)_minmax(110px,1.2fr)] items-center gap-x-3'

function Hours({ minutes, tone }: { minutes: number; tone?: 'pto' | 'holiday' | 'total' }) {
  const chip =
    tone === 'pto' && minutes > 0 ? 'bg-[color:var(--tms-badge-blue-tint)] text-[color:var(--tms-badge-blue)]'
      : tone === 'holiday' && minutes > 0 ? 'bg-[color:var(--tms-badge-orange-tint)] text-[color:var(--tms-badge-orange)]'
        : tone === 'total' ? 'font-bold text-foreground'
          : 'text-foreground'
  return (
    <div className="text-right">
      <span className={`inline-block rounded-md px-2 py-0.5 text-base tabular-nums ${chip}`}>{hm(minutes)}</span>
      <div className="pr-2 text-[11px] tabular-nums text-muted-foreground">{decimalHours(minutes)} h</div>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-[110px] rounded-lg border border-border bg-background px-4 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${tone ?? 'text-foreground'}`}>{value}</p>
      {sub && <p className="text-[11px] tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  )
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' })
}

const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }) : null

/** Clock time against wheel time for one day — context, not a finding (unchanged wording). */
function TruckTime({ truck, edges }: { truck?: TruckDayWindow; edges: { earlyInMinutes: number | null; lateOutMinutes: number | null } }) {
  if (!truck) return <span className="text-muted-foreground">no Motive data</span>
  if (!truck.firstMoveAt) return <span className="text-muted-foreground">truck did not move</span>
  const flag = (m: number | null) => m != null && m > CLOCK_EDGE_TOLERANCE_MINUTES
  const notes = [
    flag(edges.earlyInMinutes) ? `clocked on ${edges.earlyInMinutes}m before driving` : null,
    flag(edges.lateOutMinutes) ? `${edges.lateOutMinutes}m after` : null,
  ].filter(Boolean)
  return (
    <div className="flex flex-col gap-0.5">
      <span className="tabular-nums text-foreground">
        {clock(truck.firstMoveAt)} – {clock(truck.lastMoveAt)}
        {truck.vehicles?.length ? <span className="ml-1.5 text-muted-foreground">#{truck.vehicles.join(', #')}</span> : null}
      </span>
      {notes.length > 0 && <span className="text-muted-foreground">{notes.join(', ')}</span>}
    </div>
  )
}

function WeekSubtotal({ week, label }: { week: WeekTotal; label: string }) {
  return (
    <tr className="border-b border-border bg-muted/40 text-xs font-semibold tabular-nums">
      <td className="px-3 py-1.5 text-muted-foreground" colSpan={3}>{label} subtotal</td>
      <td className="px-3 py-1.5 text-right">{hm(week.workedMinutes)}</td>
      <td className="px-3 py-1.5 text-right text-[color:var(--tms-badge-blue)]">{hm(week.ptoMinutes)}</td>
      <td className="px-3 py-1.5 text-right text-[color:var(--tms-badge-orange)]">{hm(week.holidayMinutes)}</td>
      <td className="px-3 py-1.5 text-right text-foreground">{hm(week.totalMinutes)}</td>
      <td colSpan={3} />
    </tr>
  )
}

function DriverDays({ row, motive, editing, setEditing, saving, onStartEdit, onSaveEdit }: {
  row: DriverHoursRow
  motive: Record<string, TruckDayWindow> | undefined
  editing: DayEdit | null
  setEditing: (e: DayEdit | null) => void
  saving: boolean
  onStartEdit: (rowId: string) => void
  onSaveEdit: (rowId: string) => void
}) {
  const days = row.period.days
  return (
    <table className="w-full text-sm" aria-label={`${row.name} day by day`}>
      <thead>
        <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
          <th className="px-3 py-2 font-medium">Date</th>
          <th className="px-3 py-2 font-medium">In / Out</th>
          <th className="px-3 py-2 font-medium">Entries</th>
          <th className="px-3 py-2 text-right font-medium">Worked</th>
          <th className="px-3 py-2 text-right font-medium">PTO</th>
          <th className="px-3 py-2 text-right font-medium">Holiday</th>
          <th className="px-3 py-2 text-right font-medium">Day total</th>
          <th className="px-3 py-2 font-medium">Truck moving (FYI)</th>
          <th className="px-3 py-2 font-medium">Note</th>
          <th className="px-3 py-2 font-medium print:hidden">Correct</th>
        </tr>
      </thead>
      <tbody>
        {days.flatMap((day: DayTotal, i) => {
          const weekend = [0, 6].includes(new Date(`${day.date}T12:00:00Z`).getUTCDay())
          const empty = day.rows.length === 0
          const work = day.rows.filter((r) => r.kind === 'WORK')
          const stretches = work.map((r) => `${clock(r.clockInAt) ?? '—'} – ${r.clockOutAt ? clock(r.clockOutAt) : 'on the clock'}`)
          const truck = motive?.[day.date]
          const warn = dayWarning(day, truck)
          const out = [
            <tr key={day.date} className={`border-b border-border/60 ${empty && weekend ? 'opacity-40' : empty ? 'opacity-60' : ''}`}>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {dayLabel(day.date)}
                {warn && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-[color:var(--tms-badge-red-tint)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--tms-badge-red)]">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" /> {warn === 'open' ? 'on the clock' : 'check times'}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-xs tabular-nums">{stretches.length ? stretches.map((s) => <div key={s}>{s}</div>) : <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-2">
                {empty ? <span className="text-muted-foreground">—</span> : (
                  <div className="flex flex-col gap-0.5">
                    {day.rows.map((r) => (
                      <span key={r.id} className="text-xs text-muted-foreground">
                        {r.kind === 'WORK' ? 'Worked' : r.kind === 'HOLIDAY' ? 'Paid holiday' : 'PTO day'}
                        {r.correctedBy ? ` · corrected by ${r.correctedBy}` : ''}
                        {r.originalMinutes != null ? ` (was ${minutesLabel(r.originalMinutes)})` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{day.open ? <span className="text-muted-foreground">on the clock</span> : hm(day.workedMinutes)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${day.ptoMinutes ? 'font-semibold text-[color:var(--tms-badge-blue)]' : 'text-muted-foreground'}`}>{hm(day.ptoMinutes)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${day.holidayMinutes ? 'font-semibold text-[color:var(--tms-badge-orange)]' : 'text-muted-foreground'}`}>{hm(day.holidayMinutes)}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{hm(day.totalMinutes)}</td>
              <td className="px-3 py-2 text-xs"><TruckTime truck={truck} edges={clockEdges(day, truck)} /></td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{day.rows.map((r) => r.note).filter(Boolean).join(' · ')}</td>
              <td className="px-3 py-2 print:hidden">
                {day.rows.map((r) => (
                  <div key={r.id} className="flex items-center gap-1">
                    {editing?.id === r.id ? (
                      <>
                        <Input aria-label="Hours" className="h-7 w-16 text-xs" value={editing.hours} onChange={(e) => setEditing({ ...editing, hours: e.target.value })} />
                        <Input aria-label="Note" className="h-7 w-40 text-xs" placeholder="why" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                        <Button size="sm" className="h-7 px-2" disabled={saving} aria-label="Save correction" onClick={() => onSaveEdit(r.id)}><Check className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Cancel correction" onClick={() => setEditing(null)}><X className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onStartEdit(r.id)}>
                        <Pencil className="mr-1 h-3 w-3" aria-hidden="true" /> Edit
                      </Button>
                    )}
                  </div>
                ))}
              </td>
            </tr>,
          ]
          if (i === 6) out.push(<WeekSubtotal key="w1" week={row.period.weeks[0]} label="Week 1" />)
          if (i === 13) out.push(<WeekSubtotal key="w2" week={row.period.weeks[1]} label="Week 2" />)
          return out
        })}
      </tbody>
    </table>
  )
}

/** Inline rate editor: dollars an hour and the day it starts. Pay-gated by the caller. */
function RateEditor({ name, currentFrom, defaultFrom, initialRate, onSave, onCancel }: {
  name: string
  currentFrom: string | null
  defaultFrom: string
  initialRate: number | null
  onSave: (rate: number, from: string) => Promise<void>
  onCancel: () => void
}) {
  const [rate, setRate] = useState(initialRate != null ? String(initialRate) : '')
  const [from, setFrom] = useState(defaultFrom)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try { await onSave(Number(rate), from) } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the rate'); setBusy(false) }
  }
  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-border bg-muted/30 px-4 py-3 print:hidden" role="group" aria-label={`${name} hourly rate`}>
      <label className="text-xs text-muted-foreground">
        Rate ($ per hour)
        <Input aria-label="Hourly rate" className="mt-1 h-8 w-28" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.00" />
      </label>
      <label className="text-xs text-muted-foreground">
        Effective from
        <Input aria-label="Effective from" type="date" className="mt-1 h-8 w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <Button size="sm" disabled={busy} onClick={() => void submit()}>Save rate</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      <p className="basis-full text-[11px] text-muted-foreground">
        A change ends the old rate on this date and keeps it for earlier days, so periods already paid do not change.
        {currentFrom ? ` The current rate began ${currentFrom}.` : ''}
      </p>
      {error && <p role="alert" className="basis-full text-xs text-[color:var(--tms-badge-red)]">{error}</p>}
    </div>
  )
}

export function HoursPeriodView({
  rows, periodLabel, defaultRateFrom, showPay, ratesReady, motive, ptoYear, ptoDays, rateInfo, onSaveRate, onExportCsv,
  editing, setEditing, saving, onStartEdit, onSaveEdit,
}: {
  rows: DriverHoursRow[]
  periodLabel: string
  /** Start of the period on screen: the default "effective from" for a new rate. */
  defaultRateFrom: string
  showPay: boolean
  /** Rates finished loading. While they have not (or failed), no rate or editor is offered. */
  ratesReady: boolean
  motive: Record<string, Record<string, TruckDayWindow>>
  ptoYear: string
  /** driverId -> PTO days used this calendar year, when loaded. */
  ptoDays: Record<string, number> | null
  /** driverId -> the current rate's start and value, for the editor. */
  rateInfo: (driverId: string) => { currentFrom: string | null; rate: number | null }
  onSaveRate: (driverId: string, rate: number, from: string) => Promise<void>
  onExportCsv: () => void
  editing: DayEdit | null
  setEditing: (e: DayEdit | null) => void
  saving: boolean
  onStartEdit: (rowId: string) => void
  onSaveEdit: (rowId: string) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [rateFor, setRateFor] = useState<string | null>(null)
  const totals = totalsOf(rows)
  // Until the rates are known no dollar figure is shown, whatever the rows carry.
  const totalPay = ratesReady ? totals.totalPay : null
  const cols = showPay ? PAY_COLS : COLS
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allOpen = rows.length > 0 && open.size === rows.length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-stretch gap-3" role="group" aria-label={`Summary for ${periodLabel}`}>
        <Stat label="Drivers" value={String(totals.drivers)} />
        <Stat label="Total hours" value={hm(totals.totalMinutes)} sub={`${decimalHours(totals.totalMinutes)} h`} />
        <Stat label="Worked" value={hm(totals.workedMinutes)} sub={`${decimalHours(totals.workedMinutes)} h`} />
        <Stat label="Total PTO" value={hm(totals.ptoMinutes)} sub={`${decimalHours(totals.ptoMinutes)} h`} tone="text-[color:var(--tms-badge-blue)]" />
        <Stat label="Total holiday" value={hm(totals.holidayMinutes)} sub={`${decimalHours(totals.holidayMinutes)} h`} tone="text-[color:var(--tms-badge-orange)]" />
        {showPay && <Stat label="Total pay" value={money(totalPay)} sub={periodLabel} tone="text-[color:var(--tms-badge-green)]" />}
        <div className="ml-auto flex items-end gap-2 print:hidden">
          <Button variant="outline" size="sm" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((r) => r.driverId)))}>
            {allOpen ? 'Collapse all' : 'Expand all'}
          </Button>
          <Button variant="outline" size="sm" onClick={onExportCsv}>Export CSV</Button>
          <Button variant="outline" size="sm" onClick={() => { setOpen(new Set(rows.map((r) => r.driverId))); setTimeout(() => window.print(), 50) }}>
            <Printer className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Print
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background">
        <div className={`${cols} border-b border-border px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground`}>
          <span />
          <span>Driver</span>
          <span className="text-right">Worked hrs</span>
          <span className="text-right">PTO hrs</span>
          <span className="text-right">Holiday hrs</span>
          <span className="text-right">Total hrs</span>
          {showPay && <span className="text-right">Rate ($/hr)</span>}
          {showPay && <span className="text-right">2-week pay</span>}
        </div>

        {rows.map((row) => {
          const isOpen = open.has(row.driverId)
          const info = showPay ? rateInfo(row.driverId) : null
          const warnDays = row.period.days.filter((d) => dayWarning(d, motive[row.driverId]?.[d.date])).length
          return (
            <section key={row.driverId} className="border-b border-border last:border-0" aria-label={row.name}>
              <div className={`${cols} px-4 py-3 ${isOpen ? 'bg-muted/30' : 'hover:bg-muted/20'}`}>
                <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${row.name}`} onClick={() => toggle(row.driverId)} className="text-muted-foreground print:hidden">
                  {isOpen ? <ChevronDown className="h-5 w-5" aria-hidden="true" /> : <ChevronRight className="h-5 w-5" aria-hidden="true" />}
                </button>
                <button type="button" onClick={() => toggle(row.driverId)} className="min-w-0 text-left">
                  <span className="block truncate text-base font-semibold text-foreground">{row.name}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    {ptoDays && <span>PTO used {ptoYear}: {ptoDays[row.driverId] ?? 0} days</span>}
                    {warnDays > 0 && (
                      <span className="inline-flex items-center gap-1 font-semibold text-[color:var(--tms-badge-red)]">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> {warnDays} {warnDays === 1 ? 'day' : 'days'} to check
                      </span>
                    )}
                  </span>
                </button>
                <Hours minutes={row.period.workedMinutes} />
                <Hours minutes={row.period.ptoMinutes} tone="pto" />
                <Hours minutes={row.period.holidayMinutes} tone="holiday" />
                <Hours minutes={row.period.totalMinutes} tone="total" />
                {showPay && row.pay && info && (
                  <div className="text-right">
                    {!ratesReady ? (
                      <span className="text-base text-muted-foreground" title="Rates are not loaded">—</span>
                    ) : row.pay.rate != null ? (
                      <>
                        <span className="text-base tabular-nums text-foreground">{money(row.pay.rate)}</span>
                        {row.pay.mixedRates && <div className="text-[11px] text-muted-foreground">rate changed in period</div>}
                        <button type="button" aria-label={`Edit ${row.name} hourly rate`} className="ml-1 text-muted-foreground print:hidden" onClick={() => setRateFor(row.driverId)}>
                          <Pencil className="inline h-3 w-3" aria-hidden="true" />
                        </button>
                      </>
                    ) : info.rate != null ? (
                      // A rate exists but began after this period: nothing to show for these days.
                      <>
                        <span className="text-base text-muted-foreground">—</span>
                        <button type="button" aria-label={`Edit ${row.name} hourly rate`} className="ml-1 text-muted-foreground print:hidden" onClick={() => setRateFor(row.driverId)}>
                          <Pencil className="inline h-3 w-3" aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <button type="button" className="text-sm font-semibold text-primary underline print:hidden" onClick={() => setRateFor(row.driverId)}>Set rate</button>
                    )}
                  </div>
                )}
                {showPay && row.pay && (
                  <div className="text-right">
                    <span className="text-lg font-bold tabular-nums text-[color:var(--tms-badge-green)]">{money(ratesReady ? row.pay.pay : null)}</span>
                    {ratesReady && (row.pay.partial || (row.pay.rate == null && info?.rate != null && row.period.totalMinutes > 0)) && (
                      <div className="text-[11px] text-[color:var(--tms-badge-orange)]">some days have no rate</div>
                    )}
                  </div>
                )}
              </div>
              {showPay && ratesReady && rateFor === row.driverId && info && (
                <RateEditor
                  name={row.name}
                  currentFrom={info.currentFrom}
                  defaultFrom={defaultRateFrom}
                  initialRate={info.rate}
                  onSave={async (rate, from) => { await onSaveRate(row.driverId, rate, from); setRateFor(null) }}
                  onCancel={() => setRateFor(null)}
                />
              )}
              {isOpen && (
                <div className="overflow-x-auto border-t border-border">
                  <DriverDays
                    row={row}
                    motive={motive[row.driverId]}
                    editing={editing}
                    setEditing={setEditing}
                    saving={saving}
                    onStartEdit={onStartEdit}
                    onSaveEdit={onSaveEdit}
                  />
                </div>
              )}
            </section>
          )
        })}

        <div className={`${cols} border-t-2 border-border bg-muted/40 px-4 py-3`} aria-label="Totals">
          <span />
          <span className="text-sm font-bold uppercase tracking-wide text-foreground">Total · {totals.drivers} {totals.drivers === 1 ? 'driver' : 'drivers'}</span>
          <Hours minutes={totals.workedMinutes} />
          <Hours minutes={totals.ptoMinutes} tone="pto" />
          <Hours minutes={totals.holidayMinutes} tone="holiday" />
          <Hours minutes={totals.totalMinutes} tone="total" />
          {showPay && <span />}
          {showPay && <span className="text-right text-lg font-bold tabular-nums text-[color:var(--tms-badge-green)]">{money(totalPay)}</span>}
        </div>
      </div>
    </div>
  )
}
