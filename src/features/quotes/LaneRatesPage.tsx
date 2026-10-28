/**
 * `/rates` — what a lane has actually paid.
 *
 * Type a lane and the page answers with the same panel the quote form shows, plus the
 * loads behind the numbers. The two keys come from `laneLookupKeys`, which builds the
 * stop shape a load carries and lets `laneKeyFor` normalise it — a page that upper-cased
 * and piped its own string would key differently from the sampler and silently find
 * nothing.
 *
 * A lane with no history falls back to its ZIP3 neighbourhood, and the panel says so.
 * Nothing here averages anything itself: `useLaneStats` runs `laneStats` and the rows
 * below are the samples those statistics were computed over, so a figure and the loads
 * behind it can never disagree.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Route, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLaneStats } from '@/hooks/useLaneStats'
import { formatCents } from '@/lib/invoiceBuild'
import { laneLabelFor } from '@/lib/laneKey'
import { cn } from '@/lib/utils'
import { LaneHistoryPanel } from './components/LaneHistoryPanel'
import { EMPTY_LANE_LOOKUP, laneLookupKeys, type LaneLookupInput } from './quoteViews'

const TH = 'px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-2 align-top'
const MONEY = 'px-2 py-2 text-right tabular-nums align-top'

export function LaneRatesPage() {
  const [draft, setDraft] = useState<LaneLookupInput>(EMPTY_LANE_LOOKUP)
  const [lookup, setLookup] = useState<LaneLookupInput>(EMPTY_LANE_LOOKUP)

  const keys = useMemo(() => laneLookupKeys(lookup), [lookup])
  const { samples, basis, badge, loading, error } = useLaneStats(keys.laneKey, keys.laneKey3)

  const asked = keys.laneKey !== null || keys.laneKey3 !== null
  const draftKeys = laneLookupKeys(draft)
  const canLook = draftKeys.laneKey !== null || draftKeys.laneKey3 !== null

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Route size={18} />
        <h1 className="text-lg font-semibold">Lane rates</h1>
        {asked && <Badge variant="outline">{laneLabelFor(keys.laneKey) || keys.laneKey3}</Badge>}
        {asked && <Badge variant="outline">{badge}</Badge>}
      </header>

      <section className="border-b border-border px-5 py-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
          <Field label="Origin city" value={draft.originCity} onChange={(v) => setDraft((p) => ({ ...p, originCity: v }))} />
          <Field label="State" value={draft.originState} onChange={(v) => setDraft((p) => ({ ...p, originState: v }))} />
          <Field label="ZIP" value={draft.originZip} onChange={(v) => setDraft((p) => ({ ...p, originZip: v }))} />
          <Field label="Destination city" value={draft.destCity} onChange={(v) => setDraft((p) => ({ ...p, destCity: v }))} />
          <Field label="State" value={draft.destState} onChange={(v) => setDraft((p) => ({ ...p, destState: v }))} />
          <Field label="ZIP" value={draft.destZip} onChange={(v) => setDraft((p) => ({ ...p, destZip: v }))} />
          <div className="flex items-end">
            <Button aria-label="Look up the lane" disabled={!canLook} onClick={() => setLookup(draft)}>
              <Search size={14} /> Look up
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          City and a two-letter state key the lane exactly; the ZIPs give the three-digit
          neighbourhood a thin lane falls back to.
        </p>
      </section>

      {!asked && (
        <p className="px-5 py-8 text-sm text-muted-foreground">
          Name a lane to see what it has paid.
        </p>
      )}

      {asked && (
        <div className="grid flex-1 gap-4 px-5 py-4 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <LaneHistoryPanel laneKey={keys.laneKey} laneKey3={keys.laneKey3} />
          </div>

          <div className="lg:col-span-2">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {loading && <p className="text-sm text-muted-foreground">Reading the lane…</p>}
            {!loading && samples.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing has moved on this lane or its neighbourhood yet.
              </p>
            )}
            {samples.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className={TH} scope="col">Date</th>
                    <th className={TH} scope="col">Shipment</th>
                    <th className={TH} scope="col">Customer</th>
                    <th className={TH} scope="col">Carrier</th>
                    <th className={cn(TH, 'text-right')} scope="col">Revenue</th>
                    <th className={cn(TH, 'text-right')} scope="col">Cost</th>
                    <th className={cn(TH, 'text-right')} scope="col">Margin</th>
                    <th className={cn(TH, 'text-right')} scope="col">Miles</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((sample) => (
                    <tr key={sample.id} className="border-b border-border/60">
                      <td className={TD}>{sample.date}</td>
                      <td className={TD}>
                        <Link className="text-primary hover:underline" to={`/shipments/${sample.shipmentId}`}>
                          {sample.shipmentNumber ?? sample.shipmentId}
                        </Link>
                      </td>
                      <td className={TD}>{sample.customerName ?? '—'}</td>
                      <td className={TD}>
                        {sample.assignmentKind === 'OWN_ASSET' ? 'Own asset' : sample.carrierName ?? '—'}
                      </td>
                      <td className={MONEY}>
                        {sample.revenueCents != null ? formatCents(sample.revenueCents) : '—'}
                      </td>
                      <td className={MONEY}>
                        {sample.costCents != null ? formatCents(sample.costCents) : '—'}
                      </td>
                      <td className={MONEY}>
                        {sample.marginBps != null ? `${(sample.marginBps / 100).toFixed(1)}%` : '—'}
                      </td>
                      <td className={MONEY}>{sample.miles ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {basis === 'ZIP3' && samples.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                These loads are the three-digit neighbourhood, not this exact lane.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Input aria-label={label} className="h-9 text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
