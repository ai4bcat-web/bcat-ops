/**
 * What this lane has actually paid — the only evidence behind a price on the quote form
 * and the Financials tab.
 *
 * The panel never invents a number. When the lane itself has no samples the hook falls
 * back to the ZIP3 neighbourhood and says so in the badge; when neither has any, this
 * says "No history on this lane" rather than drawing zeros, because a zero here reads as
 * free freight and somebody would quote against it.
 *
 * The equipment and rate-type boxes open on what the shipment in front of you actually
 * is, which is the comparable set; "Any" widens them. Own-fleet legs are left out of the
 * carrier side by default: our own truck bought nothing, and its zero cost would drag a
 * lane's average to the floor.
 */
import { useMemo, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useLaneStats } from '@/hooks/useLaneStats'
import { laneLabelFor } from '@/lib/laneKey'
import { formatCents } from '@/lib/invoiceBuild'
import type { LaneStatsSide, LaneStatsWindow, RateType } from '@/types/tms'

const WINDOWS: { value: LaneStatsWindow; label: string }[] = [
  { value: 90, label: '90 d' },
  { value: 180, label: '180 d' },
  { value: 365, label: '1 y' },
  { value: 'ALL', label: 'All' },
]

const RATE_TYPES: RateType[] = ['SPOT', 'CONTRACT']

function money(cents: number | null): string {
  return cents == null ? '—' : formatCents(cents)
}

/** Cents per mile reads in dollars and cents, to the cent: `$2.41`. */
function perMile(cents: number | null): string {
  return cents == null ? '—' : `$${(cents / 100).toFixed(2)}`
}

function SideStats({ title, side, note }: { title: string; side: LaneStatsSide; note?: string }) {
  return (
    <div className="@container rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <span className="text-xs text-muted-foreground">{side.count} {side.count === 1 ? 'load' : 'loads'}</span>
      </div>
      {side.count === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{note ?? 'Nothing in this window.'}</p>
      ) : (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm @sm:grid-cols-3 @lg:grid-cols-5">
          <Cell label="Low" value={money(side.lowCents)} />
          <Cell label="Median" value={money(side.medianCents)} />
          <Cell label="Avg" value={money(side.avgCents)} />
          <Cell label="High" value={money(side.highCents)} />
          <Cell label="Per mile" value={perMile(side.perMileCents)} />
        </dl>
      )}
    </div>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  )
}

export function LaneHistoryPanel({ laneKey, laneKey3, miles, equipmentType, rateType }: {
  laneKey: string | null
  laneKey3: string | null
  miles?: number | null
  equipmentType?: string | null
  rateType?: RateType | null
}) {
  const [windowDays, setWindowDays] = useState<LaneStatsWindow>(180)
  const [equipment, setEquipment] = useState<string>(equipmentType ?? '')
  const [rate, setRate] = useState<RateType | ''>(rateType ?? '')
  const [includeOwnFleetCost, setIncludeOwnFleetCost] = useState(false)

  const { stats, basis, badge, samples, loading, error, refresh } = useLaneStats(laneKey, laneKey3, {
    windowDays,
    equipmentType: equipment || null,
    rateType: rate || null,
    includeOwnFleetCost,
  })

  // Only the equipment this lane has actually moved, plus whatever the shipment is.
  const equipmentOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const sample of samples) {
      const value = (sample.equipmentType ?? '').trim()
      if (value) seen.add(value)
    }
    if (equipmentType?.trim()) seen.add(equipmentType.trim())
    return [...seen].sort()
  }, [samples, equipmentType])

  const empty = basis === 'NONE'
  const nothingInWindow = !empty && stats.customer.count === 0 && stats.carrier.count === 0

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="lane-history">
      <div className="flex flex-wrap items-center gap-2">
        <History size={14} className="text-muted-foreground" />
        <p className="text-sm font-medium">Lane history</p>
        <span className="text-xs text-muted-foreground">{laneLabelFor(laneKey)}</span>
        {basis !== 'NONE' && (
          <Badge variant="outline" className="text-[10px]">{badge}</Badge>
        )}
        {basis === 'ZIP3' && (
          <Badge variant="outline" className="text-[10px]">ZIP3 neighbourhood</Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2"
          onClick={() => { void refresh() }}
          disabled={loading}
          aria-label="Refresh lane history"
        >
          <RefreshCw size={13} />
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1" role="group" aria-label="Lane history window">
          {WINDOWS.map((w) => (
            <Button
              key={String(w.value)}
              type="button"
              size="sm"
              variant={windowDays === w.value ? 'default' : 'outline'}
              className="h-7 px-2 text-xs"
              onClick={() => setWindowDays(w.value)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Equipment</Label>
          <select
            aria-label="Lane history equipment"
            value={equipment}
            onChange={(e) => setEquipment(e.target.value)}
            className="mt-1 h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Any equipment</option>
            {equipmentOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Rate type</Label>
          <select
            aria-label="Lane history rate type"
            value={rate}
            onChange={(e) => {
              const next = e.target.value
              setRate(next === 'SPOT' || next === 'CONTRACT' ? next : '')
            }}
            className="mt-1 h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Any rate</option>
            {RATE_TYPES.map((value) => (
              <option key={value} value={value}>{value === 'SPOT' ? 'Spot' : 'Contract'}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {loading && samples.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading lane history…</p>
      ) : empty ? (
        <p className="text-sm text-muted-foreground">No history on this lane.</p>
      ) : nothingInWindow ? (
        <p className="text-sm text-muted-foreground">No history on this lane in this window.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <SideStats title="Customer" side={stats.customer} />
            <SideStats
              title="Carrier cost"
              side={stats.carrier}
              note={includeOwnFleetCost ? 'Nothing in this window.' : 'Every load in this window ran on our own trucks.'}
            />
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Avg margin {stats.marginAvgBps != null ? `${(stats.marginAvgBps / 100).toFixed(1)}%` : '—'}</span>
            <span>Avg miles {stats.milesAvg != null ? Math.round(stats.milesAvg) : '—'}</span>
            {miles != null && <span>This load {Math.round(miles)} mi</span>}
            <span>Last {stats.lastAt ?? '—'}</span>
          </div>

          {stats.byMonth.length > 0 && (
            <div className="overflow-x-auto">
              <div className="flex gap-2" data-testid="lane-history-months">
                {stats.byMonth.map((month) => (
                  <div key={month.month} className="min-w-24 rounded-md border border-border px-2 py-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{month.month}</p>
                    <p className="text-xs font-medium">{money(month.customerAvgCents)}</p>
                    <p className="text-xs text-muted-foreground">{money(month.carrierAvgCents)}</p>
                    <p className="text-[10px] text-muted-foreground">{month.count} {month.count === 1 ? 'load' : 'loads'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <label className="flex items-start gap-2.5 text-xs text-muted-foreground">
        <Checkbox
          aria-label="Include own fleet cost"
          checked={includeOwnFleetCost}
          onCheckedChange={(v) => setIncludeOwnFleetCost(v === true)}
        />
        Own-fleet legs are left out of the carrier cost unless this is ticked — our own truck bought nothing.
      </label>
    </div>
  )
}
