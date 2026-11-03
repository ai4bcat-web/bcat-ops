import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Package, DollarSign, AlertCircle, CalendarClock,
  RefreshCw, Plus, Handshake,
} from 'lucide-react'
import { KpiCard } from '@/components/ui/kpi-card'
import { useDashboardMetrics, type DateRangeKey } from '@/hooks/useDashboardMetrics'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import { factoringTotals, type FactoringTotals } from '@/lib/factoringTotals'
import type { RevenueSplit, LoadsSplit } from '@/lib/revenueByFleet'
import { useLoads } from '@/hooks/useLoads'
import { ComplianceAlertsWidget } from './ComplianceAlertsWidget'
import { RepairInvoicesWidget } from './RepairInvoicesWidget'
import { VendorApCard } from './VendorApCard'
import { DriverLeaderboardWidget } from './DriverLeaderboardWidget'
import { YearProfitWidget } from './YearProfitWidget'
import { DieselPriceWidget } from './DieselPriceWidget'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useAuth } from '@/hooks/useAuth'
import { useTmsTokens } from '@/features/tms/tmsTokens'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'

// ── Helpers ───────────────────────────────────────────────────────────────────

function cents(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n / 100)
}

// ── Internal primitives ───────────────────────────────────────────────────────

function DualDeltaBadge({ delta, dir }: { delta: string; dir: 'up' | 'down' | 'neutral' }) {
  const color = dir === 'up' ? 'var(--tms-badge-green)' : dir === 'down' ? 'var(--tms-badge-red)' : 'var(--tms-text-2)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, color, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
      {dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''} {delta}
    </span>
  )
}

function BrokerCoveredCard({ count, countDelta, revenue, revenueDelta, sublabel, accent = 'var(--tms-badge-purple)' }: {
  count: number; countDelta: number; revenue: number; revenueDelta: number; sublabel: string; accent?: string
}) {
  const dir = (n: number): 'up' | 'down' | 'neutral' => (n > 0 ? 'up' : n < 0 ? 'down' : 'neutral')
  const signed = (n: number, fmt: (v: number) => string) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`
  return (
    <div className="tms-card" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: -40, right: -40, width: 140, height: 140, borderRadius: '50%', background: accent, filter: 'blur(60px)', opacity: 0.18, pointerEvents: 'none' }} />
      <div style={{ padding: '16px 18px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>Broker Covered</div>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tms-text-2)' }}>
            <Handshake size={15} />
          </div>
        </div>
        {/* Load count */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{count}</div>
          <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>loads</div>
          <DualDeltaBadge delta={signed(countDelta, (v) => String(v))} dir={dir(countDelta)} />
        </div>
        {/* Revenue */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{cents(revenue)}</div>
          <DualDeltaBadge delta={signed(revenueDelta, cents)} dir={dir(revenueDelta)} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{sublabel}</div>
      </div>
    </div>
  )
}

/**
 * The factoring queue as money, not just a count.
 *
 * "12 to factor" says nothing about whether that is a quiet afternoon or thirty thousand
 * dollars sitting unsent. Three buckets, each with its own figure, and one line across the
 * top for what is still owed to us — waiting to send plus sent and unpaid — because that is
 * the number somebody actually wants when they ask how the week is going.
 *
 * Where a row cannot be valued it is SAID, never folded into the total as zero. A figure
 * that quietly omits rows is worse than no figure on a card whose whole job is the amount.
 */
function FactoringCard({ totals, loading, onOpen }: {
  totals: FactoringTotals
  loading: boolean
  onOpen: () => void
}) {
  const accent = totals.needToFactor.count > 0 ? 'var(--tms-badge-red)' : 'var(--tms-primary)'
  const rows: { label: string; bucket: FactoringTotals['needToFactor']; color: string }[] = [
    { label: 'Need to factor', bucket: totals.needToFactor, color: 'var(--tms-badge-orange)' },
    { label: 'Pending with OTR', bucket: totals.pendingWithOtr, color: 'var(--tms-badge-blue)' },
    { label: 'Invoice manually', bucket: totals.manualInvoice, color: 'var(--tms-badge-pink)' },
    { label: 'Factored', bucket: totals.factored, color: 'var(--tms-badge-green)' },
  ]
  const unvalued = rows.reduce((n, r) => n + r.bucket.unvalued, 0)

  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen() }}
      className="tms-card"
      style={{ position: 'relative', cursor: 'pointer' }}
    >
      <div style={{ position: 'absolute', top: -40, right: -40, width: 140, height: 140, borderRadius: '50%',
        background: accent, filter: 'blur(60px)', opacity: 0.18, pointerEvents: 'none' }} />
      <div style={{ padding: '16px 18px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>
            Factoring
          </div>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tms-text-2)' }}>
            <AlertCircle size={15} />
          </div>
        </div>

        {/* Still owed to us — the headline, because it is the question being asked. */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1,
            color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>
            {loading ? '—' : cents(totals.outstandingAmount)}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginBottom: 12 }}>
          outstanding · {totals.outstandingCount} invoice{totals.outstandingCount === 1 ? '' : 's'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tms-text-2)', whiteSpace: 'nowrap' }}>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
                {r.label}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tms-muted)' }}>{r.bucket.count}</span>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>
                {cents(r.bucket.amount)}
              </span>
            </div>
          ))}
        </div>

        {unvalued > 0 && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--tms-badge-orange)' }}>
            {unvalued} invoice{unvalued === 1 ? '' : 's'} with no rate on the load — not in these totals
          </div>
        )}
      </div>
    </div>
  )
}

const FLEET_COLORS: Record<string, string> = {
  OWNER_OP: 'var(--tms-chart-6)', IVAN: 'var(--tms-chart-5)', BOX_TRUCK: 'var(--tms-chart-4)',
  BROKER: 'var(--tms-badge-purple)', UNASSIGNED: 'var(--tms-chart-9)',
}

/**
 * Revenue, and which fleet earned it.
 *
 * One total answers "how did we do" and nothing else. Owner operators settle a percentage
 * off brokerage loads, Ivan's drivers are on the payroll and box trucks are their own line,
 * so the single figure could not say which part of the business actually moved.
 *
 * The bar is the shape of the month at a glance; the rows underneath are the numbers for
 * when a glance is not enough. Broker-covered and driverless loads keep their own rows so
 * the parts visibly add up to the headline.
 */
function RevenueCard({ split, delta, deltaDir, sublabel, connected }: {
  split: RevenueSplit
  delta?: string
  deltaDir: 'up' | 'down' | 'neutral'
  sublabel: string
  connected: boolean
}) {
  const shown = split.byBucket.filter((b) => b.revenue > 0)
  return (
    <div className="tms-card" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: -40, right: -40, width: 140, height: 140, borderRadius: '50%',
        background: 'var(--tms-primary)', filter: 'blur(60px)', opacity: 0.18, pointerEvents: 'none' }} />
      <div style={{ padding: '16px 18px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>
            Revenue
          </div>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tms-text-2)' }}>
            <DollarSign size={15} />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1,
            color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>
            {connected ? cents(split.total) : '$0'}
          </div>
          {connected && delta && <DualDeltaBadge delta={delta} dir={deltaDir} />}
        </div>

        {/* The shape of the month. Hidden when there is nothing to shape. */}
        {split.total > 0 && (
          <div style={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', marginBottom: 10 }}>
            {shown.map((b) => (
              <div
                key={b.bucket}
                title={`${b.label}: ${cents(b.revenue)}`}
                style={{ width: `${(b.revenue / split.total) * 100}%`, background: FLEET_COLORS[b.bucket] }}
              />
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {shown.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{sublabel}</div>
          )}
          {shown.map((b) => (
            <div key={b.bucket} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tms-text-2)', whiteSpace: 'nowrap' }}>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: FLEET_COLORS[b.bucket], flexShrink: 0 }} />
                {b.label}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tms-muted)' }}>{b.loads}</span>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>
                {cents(b.revenue)}
              </span>
            </div>
          ))}
        </div>

        {split.unrated > 0 && (
          <div style={{ marginTop: 9, fontSize: 11, color: 'var(--tms-muted)' }}>
            {split.unrated} load{split.unrated === 1 ? '' : 's'} with no rate — not counted
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Total loads, and which fleet ran them — the same shape as the revenue card beside it,
 * so the two read as one picture. A count of 60 says nothing about whether the owner
 * operators carried the month or Ivan's drivers did; the rows do.
 *
 * The breakdown counts every load, rated or not, so it always adds to the headline.
 */
function LoadsCard({ split, delta, deltaDir, sublabel }: {
  split: LoadsSplit
  delta: string
  deltaDir: 'up' | 'down' | 'neutral'
  sublabel: string
}) {
  const shown = split.byBucket.filter((b) => b.loads > 0)
  return (
    <div className="tms-card" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: -40, right: -40, width: 140, height: 140, borderRadius: '50%',
        background: 'var(--tms-primary)', filter: 'blur(60px)', opacity: 0.18, pointerEvents: 'none' }} />
      <div style={{ padding: '16px 18px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>
            Total Loads
          </div>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tms-text-2)' }}>
            <Package size={15} />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1,
            color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>
            {split.total}
          </div>
          <DualDeltaBadge delta={delta} dir={deltaDir} />
        </div>

        {split.total > 0 && (
          <div style={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', marginBottom: 10 }}>
            {shown.map((b) => (
              <div
                key={b.bucket}
                title={`${b.label}: ${b.loads}`}
                style={{ width: `${(b.loads / split.total) * 100}%`, background: FLEET_COLORS[b.bucket] }}
              />
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {shown.length === 0 && <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{sublabel}</div>}
          {shown.map((b) => (
            <div key={b.bucket} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tms-text-2)', whiteSpace: 'nowrap' }}>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: FLEET_COLORS[b.bucket], flexShrink: 0 }} />
                {b.label}
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>
                {b.loads}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function IconBtn({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <button title={label} style={{
      display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
      background: 'var(--tms-bg)', border: '1px solid var(--tms-border)',
      fontSize: 12.5, color: 'var(--tms-text-2)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
    }}>
      {children}
    </button>
  )
}

// ── Range chips ───────────────────────────────────────────────────────────────

const RANGES: { value: DateRangeKey; label: string }[] = [
  { value: 'today',        label: 'Today'      },
  { value: 'this-week',    label: 'This Week'  },
  { value: 'this-month',   label: 'This Month' },
  { value: 'this-quarter', label: 'Quarter'    },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const [rangeKey, setRangeKey] = useState<DateRangeKey>('this-month')
  const metrics = useDashboardMetrics(rangeKey)

  /*
   * The factoring queue, counted off the same rows the Factoring page works from, so the
   * card and the page can never disagree about how much is waiting.
   */
  const { items: factoringItems, loading: factoringLoading } = useFactoringItems()
  // The live working set — a voided load is not revenue and must not be counted here.
  const { loads } = useLoads()
  /*
   * Valued off the loads as well as the queue: nothing is submitted yet on a NEED_TO_FACTOR
   * row, so it has no OTR amount and the rate on the load it resolves to is the only figure
   * there is.
   */
  const factoringTotalsValue = useMemo(
    () => factoringTotals(factoringItems, loads),
    [factoringItems, loads],
  )
  const navigate = useNavigate()
  const { hasPageAccess } = useAuth()
  const isMobile = useIsMobile()
  const col1 = isMobile ? '1fr' : undefined   // stack any multi-col row on mobile
  // Sparkline paints an SVG stroke from a JS string, so the token is resolved to its value.
  const { '--tms-badge-orange': orange } = useTmsTokens(['--tms-badge-orange'])

  const now = new Date()
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <TmsScrollPage
      title="Operations Dashboard"
      subtitle={`Live snapshot · ${dateLabel}`}
      actions={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Range chips */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3 }}>
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setRangeKey(r.value)}
                style={{
                  padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 12.5, fontWeight: rangeKey === r.value ? 600 : 500,
                  fontFamily: 'inherit',
                  background: rangeKey === r.value ? 'var(--tms-card)' : 'transparent',
                  color: rangeKey === r.value ? 'var(--tms-text)' : 'var(--tms-muted)',
                  boxShadow: rangeKey === r.value ? 'var(--tms-shadow)' : 'none',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          <IconBtn label="Refresh"><RefreshCw size={13} /> Refresh</IconBtn>
          {hasPageAccess('loads') && (
            <button
              onClick={() => navigate('/tms/shipments')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 7,
                background: 'var(--tms-primary)', color: 'var(--tms-on-primary)', border: 'none', cursor: 'pointer',
                fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}
            >
              <Plus size={13} /> New Load
            </button>
          )}
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── KPI strip ────────────────────────────────────────────────────── */}
        {/* Six cards, one row on desktop. */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(6, minmax(0, 1fr))', gap: 12 }}>
          <LoadsCard
            split={metrics.loadsSplit}
            delta={metrics.totalLoadsDelta > 0 ? `+${metrics.totalLoadsDelta}` : String(metrics.totalLoadsDelta)}
            deltaDir={metrics.totalLoadsDelta > 0 ? 'up' : metrics.totalLoadsDelta < 0 ? 'down' : 'neutral'}
            sublabel={`vs. previous ${RANGES.find((r) => r.value === rangeKey)?.label.toLowerCase()}`}
          />
          {/*
            The factoring queue in money, not a derived "past delivery not invoiced" guess.

            That old number came from appointment dates and the ready-to-invoice flag, so it
            could sit at forty while the queue people actually work was empty — two numbers
            about the same money, disagreeing. This reads the queue itself, and reads it as
            an amount, because "12 to factor" says nothing about whether that is a quiet
            afternoon or thirty thousand dollars sitting unsent.
          */}
          <FactoringCard
            totals={factoringTotalsValue}
            loading={factoringLoading}
            onOpen={() => navigate('/tms/factors')}
          />
          {/* What we owe vendors, beside what we are owed. */}
          <VendorApCard onOpen={() => navigate('/tms/vendors')} />
          <KpiCard
            label="Batory Appts to Book"
            value={metrics.needsAppt}
            sublabel={metrics.needsAppt > 0 ? 'Stops still on the Batory ladder' : 'All booked'}
            accent={metrics.needsAppt > 0 ? 'var(--tms-badge-orange)' : undefined}
            sparkColor={orange}
            icon={<CalendarClock size={15} />}
          />
          <RevenueCard
            split={metrics.revenueSplit}
            connected={metrics.revenueConnected}
            delta={metrics.revenueConnected ? `${metrics.revenueDelta >= 0 ? '+' : '−'}${cents(Math.abs(metrics.revenueDelta))}` : undefined}
            deltaDir={metrics.revenueDelta > 0 ? 'up' : metrics.revenueDelta < 0 ? 'down' : 'neutral'}
            sublabel={metrics.revenueConnected ? `vs. previous ${RANGES.find((r) => r.value === rangeKey)?.label.toLowerCase()}` : 'Connect rates to loads'}
          />
          <BrokerCoveredCard
            count={metrics.brokerLoads}
            countDelta={metrics.brokerLoadsDelta}
            revenue={metrics.brokerRevenue}
            revenueDelta={metrics.brokerRevenueDelta}
            sublabel={`vs. previous ${RANGES.find((r) => r.value === rangeKey)?.label.toLowerCase()}`}
          />
        </div>

        {/* ── The year so far: combined profit, month over month by source ─── */}
        <YearProfitWidget />

        {/* ── Driver leaderboard: hours (Ivan local), gross (owner-operators, box truck) ─ */}
        <DriverLeaderboardWidget />

        {/* ── Current diesel price (fleet average, week-over-week) ──────────── */}
        <DieselPriceWidget />

        {/* ── Compliance alerts + recent repair invoices ────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: col1 ?? '1fr 1fr', gap: 16 }}>
          <ComplianceAlertsWidget />
          <RepairInvoicesWidget />
        </div>
      </div>
    </TmsScrollPage>
  )
}
