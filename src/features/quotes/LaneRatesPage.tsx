/**
 * `/tms/rates/lanes` — what a lane has actually paid.
 *
 * Type a lane and the page answers with the same panel the quote form shows, plus the
 * shipments behind the numbers. The two keys come from `laneLookupKeys`, which builds
 * the stop shape a shipment carries and lets `laneKeyFor` normalise it — a page that
 * upper-cased and piped its own string would key differently from the sampler and
 * silently find nothing.
 *
 * A lane with no history falls back to its ZIP3 neighbourhood, and the panel says so.
 * Nothing here averages anything itself: `useLaneStats` runs `laneStats` and the rows
 * below are the samples those statistics were computed over, so a figure and the
 * shipments behind it can never disagree.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { TmsBadge, TmsButton, TmsCard, TmsField, TmsInput, TmsPage, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useLaneStats } from '@/hooks/useLaneStats'
import { formatCents } from '@/lib/invoiceBuild'
import { laneLabelFor } from '@/lib/laneKey'
import { LaneHistoryPanel } from './components/LaneHistoryPanel'
import { EMPTY_LANE_LOOKUP, laneLookupKeys, type LaneLookupInput } from './quoteViews'
import type { LaneRateSampleRecord } from '@/types/tms'

const MONEY_CELL: React.CSSProperties = { display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

export function LaneRatesPage() {
  const [draft, setDraft] = useState<LaneLookupInput>(EMPTY_LANE_LOOKUP)
  const [lookup, setLookup] = useState<LaneLookupInput>(EMPTY_LANE_LOOKUP)

  const keys = useMemo(() => laneLookupKeys(lookup), [lookup])
  const { samples, basis, badge, loading, error } = useLaneStats(keys.laneKey, keys.laneKey3)

  const asked = keys.laneKey !== null || keys.laneKey3 !== null
  const draftKeys = laneLookupKeys(draft)
  const canLook = draftKeys.laneKey !== null || draftKeys.laneKey3 !== null

  const columns: Array<ColumnDef<LaneRateSampleRecord>> = [
    { key: 'date', header: 'DATE', width: 110, render: (s) => s.date },
    {
      key: 'shipment',
      header: 'SHIPMENT',
      width: 150,
      render: (s) => <Link to={`/tms/shipments/${s.shipmentId}`}>{s.shipmentNumber ?? s.shipmentId}</Link>,
    },
    { key: 'customer', header: 'CUSTOMER', width: 190, render: (s) => s.customerName ?? '—' },
    {
      key: 'carrier',
      header: 'CARRIER',
      width: 190,
      render: (s) => (s.assignmentKind === 'OWN_ASSET' ? 'Own asset' : s.carrierName ?? '—'),
    },
    { key: 'revenue', header: 'REVENUE', width: 120, render: (s) => <span style={MONEY_CELL}>{s.revenueCents != null ? formatCents(s.revenueCents) : '—'}</span> },
    { key: 'cost', header: 'COST', width: 120, render: (s) => <span style={MONEY_CELL}>{s.costCents != null ? formatCents(s.costCents) : '—'}</span> },
    { key: 'margin', header: 'MARGIN', width: 110, render: (s) => <span style={MONEY_CELL}>{s.marginBps != null ? `${(s.marginBps / 100).toFixed(1)}%` : '—'}</span> },
    { key: 'miles', header: 'MILES', width: 90, render: (s) => <span style={MONEY_CELL}>{s.miles ?? '—'}</span> },
  ]

  return (
    <TmsPage
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          Lane rates
          {asked && <TmsBadge tone="blue">{laneLabelFor(keys.laneKey) || keys.laneKey3}</TmsBadge>}
          {asked && <TmsBadge tone="purple">{badge}</TmsBadge>}
        </span>
      }
      actions={<Link className="tms-btn tms-btn-secondary" to="/tms/rates">Quote board</Link>}
    >
      <TmsCard title="Look up a lane">
        <div className="tms-grid" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', alignItems: 'end' }}>
          <Field label="Origin city" value={draft.originCity} onChange={(v) => setDraft((p) => ({ ...p, originCity: v }))} />
          <Field label="State" value={draft.originState} onChange={(v) => setDraft((p) => ({ ...p, originState: v }))} />
          <Field label="ZIP" value={draft.originZip} onChange={(v) => setDraft((p) => ({ ...p, originZip: v }))} />
          <Field label="Destination city" value={draft.destCity} onChange={(v) => setDraft((p) => ({ ...p, destCity: v }))} />
          <Field label="State" value={draft.destState} onChange={(v) => setDraft((p) => ({ ...p, destState: v }))} />
          <Field label="ZIP" value={draft.destZip} onChange={(v) => setDraft((p) => ({ ...p, destZip: v }))} />
          <TmsButton variant="primary" aria-label="Look up the lane" disabled={canLook === false} onClick={() => setLookup(draft)}>
            <Search size={14} /> Look up
          </TmsButton>
        </div>
        <p className="tms-muted" style={{ marginTop: 8, fontSize: 12 }}>
          City and a two-letter state key the lane exactly; the ZIPs give the three-digit
          neighbourhood a thin lane falls back to.
        </p>
      </TmsCard>

      {asked === false && (
        <p className="tms-muted" style={{ padding: '24px 0', fontSize: 13 }}>
          Name a lane to see what it has paid.
        </p>
      )}

      {asked && (
        <div className="tms-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
          <LaneHistoryPanel laneKey={keys.laneKey} laneKey3={keys.laneKey3} />

          <TmsCard title="Shipments behind the numbers" flush>
            {error && <p className="tms-field-error" style={{ padding: 12 }}>{error}</p>}
            {loading && <p className="tms-muted" style={{ padding: 12, fontSize: 13 }}>Reading the lane…</p>}
            {loading === false && samples.length === 0 && (
              <p className="tms-muted" style={{ padding: 12, fontSize: 13 }}>
                Nothing has moved on this lane or its neighbourhood yet.
              </p>
            )}
            {samples.length > 0 && (
              <TmsTable<LaneRateSampleRecord> columns={columns} rows={samples} rowKey={(s) => s.id} />
            )}
            {basis === 'ZIP3' && samples.length > 0 && (
              <p className="tms-muted" style={{ padding: 12, fontSize: 12 }}>
                These shipments are the three-digit neighbourhood, not this exact lane.
              </p>
            )}
          </TmsCard>
        </div>
      )}
    </TmsPage>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <TmsField label={label}>
      <TmsInput aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </TmsField>
  )
}
