/**
 * The sticky summary rail (Step AR): load summary lines, live money block (Net $ and Profit % with
 * a margin dot), required checklist (click a row = scroll to and focus the field), the Activity block (stage and
 * recent audit entries) and roles. The actions live in the page's bottom ActionBar. Below 1280 px the same element becomes a collapsible bottom sheet (CSS only), so
 * there is one set of controls, one set of test ids.
 */
import { Check, ChevronUp, Circle } from 'lucide-react'
import { memo, useMemo, useState, type ComponentType } from 'react'
import { formatCents } from '@/lib/invoiceBuild'
import type { IntakeLoadRecord } from '@/types/intake'
import { ActivityBlock } from './ActivityBlock'
import { ProgressBlock } from './ProgressBlock'
import { RateHistoryRail } from './RateHistoryRail'
import { sliceOf, type CardProps } from './cards/cardRegistry'
import { carrierBreakdown } from './cards/ratesSummary'
import { requiredProgress, type RailRow, type RailSummary } from './railModel'
import type { SliceSectionProps } from './sectionRegistry'

export interface SummaryRailProps {
  common: CardProps
  summary: RailSummary
  rows: RailRow[]
  /** The user pressed Create / Save and something blocked: missing rows turn amber. */
  attempted: boolean
  Roles: ComponentType<SliceSectionProps<'roles'>>
  /** The Rate history body (feedback 18): rendered under Money, collapsible. */
  RateHistory: ComponentType<CardProps>
  /** The intake item the create page was opened from (its extractor entries show in Activity). */
  intakeId?: string
  intake?: IntakeLoadRecord | null
}

const TONE_WORD = { green: 'On target', amber: 'Near target', red: 'Below target' } as const

function SummaryRailImpl({ common, summary, rows, attempted, Roles, RateHistory, intakeId, intake }: SummaryRailProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const { values, update, ctx, form } = common
  const { money } = summary
  const { done, total, ready } = requiredProgress(rows)
  const dash = '—'
  const net = money.priced ? formatCents(money.netCents) : dash
  const pct = money.priced ? `${money.profitPct.toFixed(1)}%` : dash
  const breakdown = useMemo(() => carrierBreakdown(values, money.preview, ctx.directory.carriers), [values, money.preview, ctx.directory.carriers])
  const onRoles = useMemo(() => sliceOf(update, 'roles'), [update])

  return (
    <aside className="tms-rail" data-testid="ship-form-rail" data-sheet={sheetOpen ? 'open' : 'closed'} aria-label="Shipment summary">
      <button
        type="button" className="tms-rail-sheetbar" data-testid="rail-sheet-toggle" aria-expanded={sheetOpen}
        aria-controls="rail-body" onClick={() => setSheetOpen((o) => !o)}
      >
        <ChevronUp size={14} aria-hidden="true" className="tms-rail-sheet-chev" />
        <span className="tms-rail-sheetbar-money">
          Net {net} · {pct}
          {money.priced ? <span className="tms-rail-dot" data-tone={money.tone} aria-hidden="true" /> : null}
        </span>
        <span className="tms-rail-sheetbar-req">{done} / {total}</span>
      </button>

      <div id="rail-body" className="tms-rail-body">
        <section className="tms-rail-hero" data-testid="rail-hero" aria-label="At a glance">
          <div className="tms-rail-hero-main">
            <span className="tms-rail-hero-label">Net profit</span>
            <strong className="tms-rail-hero-big" data-testid="rail-hero-net">{net}</strong>
            <span className="tms-rail-hero-sub">{money.priced ? `${pct} margin · ${TONE_WORD[money.tone]}` : 'Price the load to see the margin'}</span>
          </div>
          <div className="tms-rail-ring" role="img" aria-label={`${done} of ${total} required fields done`} style={{ ['--ring' as string]: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }}>
            <span className="tms-rail-ring-num">{done}<small>/{total}</small></span>
            <span className="tms-rail-ring-cap">required</span>
          </div>
          <div className="tms-rail-bar" data-testid="rail-hero-bar" aria-hidden="true">
            <span className="tms-rail-bar-cost" style={{ width: `${money.priced && money.customerTotalCents > 0 ? Math.min(100, Math.round((money.carrierTotalCents / money.customerTotalCents) * 100)) : 0}%` }} />
            <span className="tms-rail-bar-profit" data-tone={money.tone} />
          </div>
          <div className="tms-rail-bar-legend">
            <span><i className="tms-rail-key tms-rail-key-profit" />Customer {money.priced ? formatCents(money.customerTotalCents) : dash}</span>
            <span><i className="tms-rail-key tms-rail-key-cost" />Carrier {money.carrierTotalCents > 0 ? formatCents(money.carrierTotalCents) : dash}</span>
          </div>
        </section>

        <section className="tms-rail-block" data-testid="rail-summary">
          <h2 className="tms-rail-h">Summary</h2>
          <p className="tms-rail-line tms-rail-line-strong" data-testid="rail-customer">{summary.customerLine || dash}</p>
          <p className="tms-rail-line" data-testid="rail-lane">{summary.laneLine || dash}</p>
          <p className="tms-rail-line" data-testid="rail-freight">{summary.freightLine || dash}</p>
        </section>

        <section className="tms-rail-block" data-testid="rail-money" aria-label="Money">
          <div className="tms-rail-money-row"><span>Customer</span><span data-testid="rail-customer-total">{money.priced ? formatCents(money.customerTotalCents) : dash}</span></div>
          <div
            className="tms-rail-money-row" data-testid="rail-carrier-row"
            title={breakdown.length > 0 ? breakdown.map((b) => `${b.label} ${formatCents(b.totalCents)}`).join(' · ') : undefined}
          ><span>Carrier</span><span data-testid="rail-carrier-total">{money.carrierTotalCents > 0 ? formatCents(money.carrierTotalCents) : dash}</span></div>
          <div className="tms-rail-money-row tms-rail-net">
            <span>Net <strong data-testid="rail-net">{net}</strong></span>
            <span className="tms-rail-profit" title={money.priced ? `${TONE_WORD[money.tone]} (target ${money.targetPct.toFixed(1)}%)` : undefined}>
              Profit <strong data-testid="rail-profit">{pct}</strong>
              {money.priced ? <span className="tms-rail-dot" data-testid="rail-margin-dot" data-tone={money.tone} role="img" aria-label={TONE_WORD[money.tone]} /> : null}
            </span>
          </div>
        </section>

        <RateHistoryRail common={common} Body={RateHistory} />

        <section className="tms-rail-block" data-testid="rail-required" aria-label="Required">
          <h2 className="tms-rail-h">Required <span className="tms-rail-count" data-testid="rail-required-count" data-ready={ready}>{done} / {total}</span></h2>
          <ul className="tms-rail-reqs">
            {rows.map((r) => (
              <li key={r.key}>
                <button
                  type="button" className="tms-rail-req" data-testid={`rail-req-${r.key}`} data-done={r.done}
                  data-missing={attempted && !r.done} title={r.done ? undefined : r.message}
                  onClick={() => form.focusField(r.fieldKey)}
                >
                  {r.done ? <Check size={12} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />}
                  <span>{r.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <ProgressBlock bundle={ctx.bundle} staff={ctx.directory.staff} config={ctx.settings?.progressSteps as never} onUncover={ctx.actions.openUncover} disabled={ctx.busy || ctx.locked.voided} />

        <ActivityBlock bundle={ctx.bundle} staff={ctx.directory.staff} intakeId={intakeId} intake={intake} />

        <section className="tms-rail-block tms-rail-roles" data-testid="rail-roles" aria-label="Roles">
          <h2 className="tms-rail-h">Roles</h2>
          <Roles value={values.roles} onChange={onRoles} ctx={ctx} form={form} />
        </section>
      </div>
    </aside>
  )
}

export const SummaryRail = memo(SummaryRailImpl)
