/**
 * Section 5: Historical Rates. Read-only: one lane-sample read (exact lane, ZIP3 only when the
 * lane has nothing, badge says which) bucketed locally into Aljex's six periods. A period with
 * no history says so; it never shows a zero.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { listLaneSamples, listLaneSamplesByZip3 } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { aliasMap } from '@/lib/integrations/postalAliases'
import { laneKey3For, laneKeyFor } from '@/lib/laneKey'
import { laneFallback, type LaneFallback } from '@/lib/laneStats'
import { LABEL } from '../labels'
import { bucketSamples, PERIODS, type LaneBucket, type PeriodKey } from '../historicalRates'
import { toStop } from '../mapping'
import type { FormStop } from '../model'
import type { HistoricalRatesProps } from '../sectionRegistry'

const DEBOUNCE_MS = 500
const DAY_MS = 86_400_000

const range = (low: number | null, high: number | null): string =>
  low !== null && high !== null && low !== high ? `${formatCents(low)} – ${formatCents(high)}` : ''

function Spread({ bucket, which }: { bucket: LaneBucket; which: 'linehaul' | 'rate' }) {
  const s = bucket[which]
  if (s.medianCents === null) return <>—</>
  const r = range(s.lowCents, s.highCents)
  return <>{formatCents(s.medianCents)}{r ? <span className="ship-hint"> ({r})</span> : null}</>
}

function HistoricalRatesImpl({ stops, equipmentType, ctx }: HistoricalRatesProps) {
  const [period, setPeriod] = useState<PeriodKey>('last30')
  const [anyEquipment, setAnyEquipment] = useState(false)
  const [loaded, setLoaded] = useState<{ keyId: string; found: LaneFallback | null } | null>(null)

  const aliases = ctx.settings?.postalCodeAliases
  const keys = useMemo(() => {
    // A lane needs a city AND a two-letter state at both ends; a half-typed end must not key a lane.
    const from = stops.find((s) => s.type === 'pickup')
    const to = [...stops].reverse().find((s) => s.type === 'delivery')
    const placed = (s: FormStop | undefined) => Boolean(s && s.city.trim() && /^[A-Za-z]{2}$/.test(s.state.trim()))
    if (!placed(from) || !placed(to)) return { lane: null, zip3: null }
    const asStops = stops.map((s, i) => toStop(s, i, 'other'))
    return { lane: laneKeyFor(asStops, aliasMap(aliases)), zip3: laneKey3For(asStops) }
  }, [stops, aliases])

  const keyId = `${keys.lane ?? ''}#${keys.zip3 ?? ''}`
  const active = keyId !== '#'

  useEffect(() => {
    if (!active) return
    let alive = true
    const timer = setTimeout(() => {
      const floor = new Date(Date.now() - 365 * DAY_MS).toISOString().slice(0, 10)
      const exact = keys.lane ? listLaneSamples(keys.lane, floor) : Promise.resolve([])
      exact
        .then(async (rows) => {
          const hasExact = keys.lane !== null && rows.some((s) => !s.excluded)
          const zip3 = !hasExact && keys.zip3 ? await listLaneSamplesByZip3(keys.zip3, floor) : []
          return laneFallback(rows, zip3, keys.lane, keys.zip3)
        })
        .then((result) => { if (alive) setLoaded({ keyId, found: result }) })
        .catch(() => { if (alive) setLoaded({ keyId, found: null }) })
    }, DEBOUNCE_MS)
    return () => { alive = false; clearTimeout(timer) }
  }, [active, keyId, keys])

  const found = active && loaded?.keyId === keyId ? loaded.found : null
  const loading = active && loaded?.keyId !== keyId

  const buckets = useMemo(
    () => (found ? bucketSamples(found.samples, new Date().toISOString(), { equipmentType, anyEquipment }) : null),
    [found, equipmentType, anyEquipment],
  )
  const bucket = buckets?.[period] ?? null

  return (
    <div className="ship-body" data-testid="section-history-body">
      <div className="ship-history-tabs" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button
            key={p.key} type="button" className="ship-history-tab" aria-pressed={period === p.key}
            data-testid={LABEL.history[p.key].testId} onClick={() => setPeriod(p.key)}
          >
            {LABEL.history[p.key].text}
          </button>
        ))}
      </div>
      {equipmentType.trim() && (
        <label className="ship-check">
          <input type="checkbox" aria-label="Any equipment" data-testid="f-history-anyEquipment" checked={anyEquipment} onChange={(e) => setAnyEquipment(e.target.checked)} />
          Any equipment
        </label>
      )}
      {found && found.basis !== 'NONE' && <span className="ship-hint" data-testid="f-history-badge">{found.badge}</span>}
      <table className="ship-history-table" data-testid="f-history-table">
        <thead>
          <tr><th scope="col">{LABEL.history.linehaul.text}</th><th scope="col">{LABEL.history.rate.text}</th></tr>
        </thead>
        <tbody>
          {bucket ? (
            <tr data-testid="f-history-row">
              <td><Spread bucket={bucket} which="linehaul" /></td>
              <td><Spread bucket={bucket} which="rate" /></td>
            </tr>
          ) : (
            <tr>
              <td colSpan={2} className="ship-hint" data-testid="f-history-empty">
                {loading ? 'Loading…' : !keys.lane && !keys.zip3 ? 'Enter both stops’ city and state to see this lane’s history.' : 'No history'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export const HistoricalRatesSection = memo(HistoricalRatesImpl)
