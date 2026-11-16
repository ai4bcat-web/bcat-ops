import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Package, DollarSign, CalendarClock,
  RefreshCw, Plus, Handshake, Sparkles,
} from 'lucide-react'
import type { RevenueSplit, LoadsSplit } from '@/lib/revenueByFleet'
import { TZ } from '@/lib/date'
import { ComplianceAlertsWidget } from './ComplianceAlertsWidget'
import { RepairInvoicesWidget } from './RepairInvoicesWidget'
import { VendorApCard } from './VendorApCard'
import { DriverLeaderboardWidget } from './DriverLeaderboardWidget'
import { YearProfitWidget } from './YearProfitWidget'
import { DieselPriceWidget } from './DieselPriceWidget'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useAuth } from '@/hooks/useAuth'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { useLegacyDashboardKpis, type DateRangeKey } from './useLegacyDashboardKpis'
import { useBatoryApptCount } from './useBatoryApptCount'
import { BrokerageSection } from './BrokerageDashboardPage'
import { LazyWidget } from './LazyWidget'
import { PayablesCard, ReceivablesCard } from './AccountingSection'
import './dashboardGrid.css'
import { DeliveryToReviewCard } from './DeliveryToReviewCard'
import { DashCard, DashRow, DashRows, Headline, SplitBar } from './DashCard'
import { dashCents } from './dashFormat'
import { AssistantChat } from '@/features/dashboards/assistant/AssistantChat'

const cents = dashCents

const sinceLabel = (rangeKey: DateRangeKey) => `vs. previous ${RANGES.find((r) => r.value === rangeKey)?.label.toLowerCase()}`
const signed = (n: number, fmt: (v: number) => string) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`
const dirOf = (n: number): 'up' | 'down' | 'neutral' => (n > 0 ? 'up' : n < 0 ? 'down' : 'neutral')

function BrokerCoveredCard({ count, countDelta, revenue, revenueDelta, sublabel }: {
  count: number; countDelta: number; revenue: number; revenueDelta: number; sublabel: string
}) {
  return (
    <DashCard label="Broker covered" icon={<Handshake size={15} />}>
      <Headline value={<>{count} <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--tms-muted)' }}>loads</span></>} delta={signed(countDelta, String)} deltaDir={dirOf(countDelta)} />
      <DashRows>
        <DashRow color="var(--tms-badge-purple)" label="Revenue" value={cents(revenue)} />
        <DashRow color="var(--tms-chart-9)" label="Change" value={<span style={{ color: revenueDelta > 0 ? 'var(--tms-badge-green)' : revenueDelta < 0 ? 'var(--tms-badge-red)' : undefined }}>{signed(revenueDelta, cents)}</span>} />
      </DashRows>
      <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{sublabel}</div>
    </DashCard>
  )
}

const FLEET_COLORS: Record<string, string> = {
  OWNER_OP: 'var(--tms-chart-6)', IVAN: 'var(--tms-chart-5)', BOX_TRUCK: 'var(--tms-chart-4)',
  BROKER: 'var(--tms-badge-purple)', UNASSIGNED: 'var(--tms-chart-9)',
}

/**
 * Revenue, and which fleet earned it. One total answers "how did we do"; the bar is the shape of the month and the
 * rows are the numbers. Broker-covered and driverless loads keep their own rows so the parts add up to the headline.
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
    <DashCard label="Revenue" icon={<DollarSign size={15} />}>
      <Headline value={connected ? cents(split.total) : '$0'} delta={connected ? delta : undefined} deltaDir={deltaDir} caption={sublabel} />
      <SplitBar parts={shown.map((b) => ({ key: b.bucket, value: b.revenue, color: FLEET_COLORS[b.bucket], title: `${b.label}: ${cents(b.revenue)}` }))} />
      <DashRows>
        {shown.map((b) => (
          <DashRow key={b.bucket} color={FLEET_COLORS[b.bucket]} label={b.label} count={b.loads} value={cents(b.revenue)} />
        ))}
      </DashRows>
      {split.unrated > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--tms-muted)' }}>
          {split.unrated} load{split.unrated === 1 ? '' : 's'} with no rate — not counted
        </div>
      )}
    </DashCard>
  )
}

/**
 * Total loads, and which fleet ran them — the same shape as the revenue card beside it. The breakdown counts every
 * load, rated or not, so it always adds to the headline.
 */
function LoadsCard({ split, delta, deltaDir, sublabel }: {
  split: LoadsSplit
  delta: string
  deltaDir: 'up' | 'down' | 'neutral'
  sublabel: string
}) {
  const shown = split.byBucket.filter((b) => b.loads > 0)
  return (
    <DashCard label="Total loads" icon={<Package size={15} />}>
      <Headline value={split.total} delta={delta} deltaDir={deltaDir} caption={sublabel} />
      <SplitBar parts={shown.map((b) => ({ key: b.bucket, value: b.loads, color: FLEET_COLORS[b.bucket], title: `${b.label}: ${b.loads}` }))} />
      <DashRows>
        {shown.map((b) => <DashRow key={b.bucket} color={FLEET_COLORS[b.bucket]} label={b.label} value={b.loads} />)}
      </DashRows>
    </DashCard>
  )
}

/** Batory stops still on the appointment ladder: a count and one line, the same shell as its neighbours. */
function BatoryCard({ count }: { count: number | null }) {
  if (count === null) return <KpiSkeleton label="Batory appts to book" />
  return (
    <DashCard label="Batory appts to book" icon={<CalendarClock size={15} />}>
      <Headline value={count} caption={count > 0 ? 'Stops still on the Batory ladder' : 'All booked'} />
    </DashCard>
  )
}

/** Placeholder with the card's footprint while its figures are unknown: no numbers, never a zero. */
function KpiSkeleton({ label }: { label: string }) {
  const bar = (w: string, h: number): React.CSSProperties => ({ height: h, width: w, borderRadius: 6, background: 'var(--tms-bg)' })
  return (
    <DashCard label={label} icon={<span />} ariaBusy>
      <div aria-label={`${label} loading`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={bar('45%', 30)} />
        <div style={bar('100%', 6)} />
        <div style={bar('70%', 12)} />
        <div style={bar('55%', 12)} />
      </div>
    </DashCard>
  )
}

/** A grid cell: keeps the visual order while the DOM groups the three rollup cards; `size` sets its span (dashboardGrid.css). */
function Cell({ order, size, children }: { order: number; size?: 's2' | 's3' | 's6'; children: React.ReactNode }) {
  return <div className={`dash-cell${size ? ` dash-${size}` : ''}`} style={{ order }}>{children}</div>
}

function asOfLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
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
  const kpi = useLegacyDashboardKpis(rangeKey)
  const metrics = kpi.kpis
  const kpiFinal = kpi.state !== 'loading'
  const needsAppt = useBatoryApptCount()

  const navigate = useNavigate()
  const { hasPageAccess, isAdmin } = useAuth()
  // The assistant's door is the same as the dashboards' (owner, ADMIN or the TMS page); the Lambda enforces it again.
  const canAsk = isAdmin || hasPageAccess('tms')
  const [askOpen, setAskOpen] = useState(false)
  const isMobile = useIsMobile()
  const col1 = isMobile ? '1fr' : undefined   // stack any multi-col row on mobile

  const now = new Date()
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <TmsScrollPage
      width="full"
      className="tms-phone-keep"
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
          {kpi.asOf && (
            <span
              data-testid="legacy-asof"
              style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: kpi.state === 'stale' ? 'var(--tms-badge-orange)' : 'var(--tms-muted)' }}
            >
              as of {asOfLabel(kpi.asOf)}
            </span>
          )}
          {canAsk && (
            <button
              type="button"
              data-testid="ask-bcat-toggle"
              aria-pressed={askOpen}
              onClick={() => setAskOpen((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 7, cursor: 'pointer',
                fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                border: '1px solid var(--tms-border)',
                background: askOpen ? 'var(--tms-primary-tint)' : 'var(--tms-card)',
                color: askOpen ? 'var(--tms-primary-ink)' : 'var(--tms-text)',
              }}
            >
              <Sparkles size={13} /> Ask BCAT
            </button>
          )}
          <IconBtn label="Refresh"><RefreshCw size={13} /> Refresh</IconBtn>
          {hasPageAccess('loads') && (
            <button
              onClick={() => navigate('/tms/shipments/new')}
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

        {canAsk && askOpen && <AssistantChat />}

        {/* ── Top cards: one packed grid across the full width (dashboardGrid.css) ── */}
        <div className="dash-top">
          <div
            className="dash-top-grid"
            data-testid="legacy-kpis-all"
            data-state={kpiFinal && needsAppt !== null ? kpi.state : 'loading'}
            data-source={kpi.source ?? ''}
            data-asof={kpi.asOf ?? ''}
            data-kpi-flips={kpi.flips}
          >
            {/* Loads, Revenue and Broker covered come from the rollup together; `display: contents` keeps them grid items. */}
            <div
              data-testid="legacy-kpis"
              data-state={kpi.state}
              data-source={kpi.source ?? ''}
              data-asof={kpi.asOf ?? ''}
              data-kpi-flips={kpi.flips}
              style={{ display: 'contents' }}
            >
              <Cell order={1} size="s2">
                {metrics ? (
                  <LoadsCard
                    split={metrics.loadsSplit}
                    delta={metrics.totalLoadsDelta > 0 ? `+${metrics.totalLoadsDelta}` : String(metrics.totalLoadsDelta)}
                    deltaDir={metrics.totalLoadsDelta > 0 ? 'up' : metrics.totalLoadsDelta < 0 ? 'down' : 'neutral'}
                    sublabel={sinceLabel(rangeKey)}
                  />
                ) : <KpiSkeleton label="Total Loads" />}
              </Cell>
              <Cell order={2} size="s3">
                {metrics ? (
                  <RevenueCard
                    split={metrics.revenueSplit}
                    connected={metrics.revenueConnected}
                    delta={metrics.revenueConnected ? `${metrics.revenueDelta >= 0 ? '+' : '−'}${cents(Math.abs(metrics.revenueDelta))}` : undefined}
                    deltaDir={metrics.revenueDelta > 0 ? 'up' : metrics.revenueDelta < 0 ? 'down' : 'neutral'}
                    sublabel={metrics.revenueConnected ? sinceLabel(rangeKey) : 'Connect rates to loads'}
                  />
                ) : <KpiSkeleton label="Revenue" />}
              </Cell>
              <Cell order={3} size="s2">
                {metrics ? (
                  <BrokerCoveredCard
                    count={metrics.brokerLoads}
                    countDelta={metrics.brokerLoadsDelta}
                    revenue={metrics.brokerRevenue}
                    revenueDelta={metrics.brokerRevenueDelta}
                    sublabel={sinceLabel(rangeKey)}
                  />
                ) : <KpiSkeleton label="Broker Covered" />}
              </Cell>
            </div>
            <Cell order={4} size="s2"><BatoryCard count={needsAppt} /></Cell>
            {/* Delivery → Load review, week over week (Ryne 2026-11-15); anyone who works loads. */}
            {(hasPageAccess('loads') || hasPageAccess('tms')) && (
              <Cell order={5} size="s3">
                <LazyWidget enabled={kpiFinal} minHeight={200} label="delivery-to-review"><DeliveryToReviewCard /></LazyWidget>
              </Cell>
            )}
            {/* Accounts receivable (with Factoring) and Accounts payable, each on its own accounting grant. */}
            {hasPageAccess('invoicing') && (
              <Cell order={6} size="s6">
                <LazyWidget enabled={kpiFinal} minHeight={240} label="accounting-ar"><ReceivablesCard /></LazyWidget>
              </Cell>
            )}
            {hasPageAccess('carrierPay') && (
              <Cell order={7} size="s3">
                <LazyWidget enabled={kpiFinal} minHeight={240} label="accounting-ap"><PayablesCard /></LazyWidget>
              </Cell>
            )}
            {/* Vendor (non-carrier) bills, next to carrier AP. */}
            <Cell order={8} size="s3">
              <VendorApCard onOpen={() => navigate('/tms/vendors')} />
            </Cell>
          </div>
        </div>

        {/* ── Brokerage (BCAT Logistics): right under the top cards ─ */}
        <LazyWidget enabled={kpiFinal} minHeight={420} label="brokerage"><BrokerageSection /></LazyWidget>

        {/* ── The year so far: combined profit, month over month by source ─── */}
        <LazyWidget enabled={kpiFinal} minHeight={320} label="year-profit"><YearProfitWidget /></LazyWidget>

        {/* ── Driver leaderboard: hours (Ivan local), gross (owner-operators, box truck) ─ */}
        <LazyWidget enabled={kpiFinal} minHeight={420} label="driver-leaderboard"><DriverLeaderboardWidget /></LazyWidget>

        {/* ── Current diesel price (fleet average, week-over-week) ──────────── */}
        <LazyWidget enabled={kpiFinal} minHeight={160} label="diesel-price"><DieselPriceWidget /></LazyWidget>

        {/* ── Compliance alerts + recent repair invoices ────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: col1 ?? '1fr 1fr', gap: 16 }}>
          <LazyWidget enabled={kpiFinal} minHeight={260} label="compliance-alerts"><ComplianceAlertsWidget /></LazyWidget>
          <LazyWidget enabled={kpiFinal} minHeight={260} label="repair-invoices"><RepairInvoicesWidget /></LazyWidget>
        </div>
      </div>
    </TmsScrollPage>
  )
}
