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
import { RefreshCw } from 'lucide-react'
import { TmsBadge, TmsButton, TmsCard, TmsField, TmsIconButton, TmsSelect } from '@/features/tms/kit'
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
    <div style={{ borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)', padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <p className="tms-field-label">{title}</p>
        <span className="tms-muted" style={{ fontSize: 12 }}>{side.count} {side.count === 1 ? 'shipment' : 'shipments'}</span>
      </div>
      {side.count === 0 ? (
        <p className="tms-muted" style={{ marginTop: 8, fontSize: 13 }}>{note ?? 'Nothing in this window.'}</p>
      ) : (
        <dl className="tms-grid tms-grid-3" style={{ marginTop: 8, fontSize: 13 }}>
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
      <dt className="tms-field-label">{label}</dt>
      <dd style={{ margin: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</dd>
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
  const nothingInWindow = empty === false && stats.customer.count === 0 && stats.carrier.count === 0

  return (
    <TmsCard
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Lane history
          <span className="tms-muted" style={{ fontSize: 12, fontWeight: 400 }}>{laneLabelFor(laneKey)}</span>
          {basis !== 'NONE' && <TmsBadge tone="purple">{badge}</TmsBadge>}
          {basis === 'ZIP3' && <TmsBadge tone="gray">ZIP3 neighbourhood</TmsBadge>}
        </span>
      }
      actions={
        <TmsIconButton shape="plain" aria-label="Refresh lane history" disabled={loading} onClick={() => { void refresh() }}>
          <RefreshCw size={13} />
        </TmsIconButton>
      }
    >
      <div style={{ display: 'grid', gap: 12 }} data-testid="lane-history">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Lane history window">
            {WINDOWS.map((w) => (
              <TmsButton
                key={String(w.value)}
                size="sm"
                variant={windowDays === w.value ? 'primary' : 'secondary'}
                onClick={() => setWindowDays(w.value)}
              >
                {w.label}
              </TmsButton>
            ))}
          </div>
          <TmsField label="Equipment">
            <TmsSelect
              aria-label="Lane history equipment"
              value={equipment}
              onChange={(e) => setEquipment(e.target.value)}
              placeholder="Any equipment"
              options={equipmentOptions.map((option) => ({ value: option, label: option }))}
            />
          </TmsField>
          <TmsField label="Rate type">
            <TmsSelect
              aria-label="Lane history rate type"
              value={rate}
              onChange={(e) => {
                const next = e.target.value
                setRate(next === 'SPOT' || next === 'CONTRACT' ? next : '')
              }}
              placeholder="Any rate"
              options={RATE_TYPES.map((value) => ({ value, label: value === 'SPOT' ? 'Spot' : 'Contract' }))}
            />
          </TmsField>
        </div>

        {error && <p className="tms-field-error">{error}</p>}

        {loading && samples.length === 0 ? (
          <p className="tms-muted" style={{ fontSize: 13 }}>Loading lane history…</p>
        ) : empty ? (
          <p className="tms-muted" style={{ fontSize: 13 }}>No history on this lane.</p>
        ) : nothingInWindow ? (
          <p className="tms-muted" style={{ fontSize: 13 }}>No history on this lane in this window.</p>
        ) : (
          <>
            <div className="tms-grid tms-grid-2">
              <SideStats title="Customer" side={stats.customer} />
              <SideStats
                title="Carrier cost"
                side={stats.carrier}
                note={includeOwnFleetCost ? 'Nothing in this window.' : 'Every shipment in this window ran on our own trucks.'}
              />
            </div>

            <div className="tms-muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12 }}>
              <span>Avg margin {stats.marginAvgBps != null ? `${(stats.marginAvgBps / 100).toFixed(1)}%` : '—'}</span>
              <span>Avg miles {stats.milesAvg != null ? Math.round(stats.milesAvg) : '—'}</span>
              {miles != null && <span>This shipment {Math.round(miles)} mi</span>}
              <span>Last {stats.lastAt ?? '—'}</span>
            </div>

            {stats.byMonth.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <div style={{ display: 'flex', gap: 8 }} data-testid="lane-history-months">
                  {stats.byMonth.map((month) => (
                    <div key={month.month} style={{ minWidth: 96, borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)', padding: '4px 8px' }}>
                      <p className="tms-field-label">{month.month}</p>
                      <p style={{ fontSize: 12, fontWeight: 600 }}>{money(month.customerAvgCents)}</p>
                      <p className="tms-muted" style={{ fontSize: 12 }}>{money(month.carrierAvgCents)}</p>
                      <p className="tms-muted" style={{ fontSize: 10 }}>{month.count} {month.count === 1 ? 'shipment' : 'shipments'}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <label className="tms-muted" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
          <input
            type="checkbox"
            aria-label="Include own fleet cost"
            checked={includeOwnFleetCost}
            onChange={(e) => setIncludeOwnFleetCost(e.target.checked)}
          />
          Own-fleet legs are left out of the carrier cost unless this is ticked — our own truck bought nothing.
        </label>
      </div>
    </TmsCard>
  )
}
