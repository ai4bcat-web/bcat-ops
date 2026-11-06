/**
 * The sticky summary rail (Step AR): load summary lines, live money block (Net $ and Profit % with
 * a margin dot), required checklist (click a row = scroll to and focus the field), the Activity block (stage and
 * recent audit entries), roles, and the
 * pinned actions. Below 1280 px the same element becomes a collapsible bottom sheet (CSS only), so
 * there is one set of controls, one set of test ids.
 */
import { Check, ChevronUp, Circle } from 'lucide-react'
import { memo, useMemo, useState, type ComponentType } from 'react'
import { TmsButton } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import type { IntakeLoadRecord } from '@/types/intake'
import { ActivityBlock } from './ActivityBlock'
import { sliceOf, type CardProps } from './cards/cardRegistry'
import { requiredProgress, type RailRow, type RailSummary } from './railModel'
import type { RunKind } from './useShipmentForm'
import type { SliceSectionProps } from './sectionRegistry'

export interface SummaryRailProps {
  common: CardProps
  summary: RailSummary
  rows: RailRow[]
  /** The user pressed Create / Save and something blocked: missing rows turn amber. */
  attempted: boolean
  status: string
  busy: boolean
  voided: boolean
  Roles: ComponentType<SliceSectionProps<'roles'>>
  /** The intake item the create page was opened from (its extractor entries show in Activity). */
  intakeId?: string
  intake?: IntakeLoadRecord | null
  onRun: (kind: RunKind) => void
  onDiscard: () => void
}

const TONE_WORD = { green: 'On target', amber: 'Near target', red: 'Below target' } as const

function SummaryRailImpl({ common, summary, rows, attempted, status, busy, voided, Roles, intakeId, intake, onRun, onDiscard }: SummaryRailProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const { mode, values, update, ctx, form } = common
  const { money } = summary
  const { done, total, ready } = requiredProgress(rows)
  const isDraft = status === 'NEW' || status === 'DRAFT'
  const createMode = mode === 'create'
  const dash = '—'
  const net = money.priced ? formatCents(money.netCents) : dash
  const pct = money.priced ? `${money.profitPct.toFixed(1)}%` : dash
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
        <section className="tms-rail-block" data-testid="rail-summary">
          <h2 className="tms-rail-h">Summary</h2>
          <p className="tms-rail-line tms-rail-line-strong" data-testid="rail-customer">{summary.customerLine || dash}</p>
          <p className="tms-rail-line" data-testid="rail-lane">{summary.laneLine || dash}</p>
          <p className="tms-rail-line" data-testid="rail-freight">{summary.freightLine || dash}</p>
        </section>

        <section className="tms-rail-block" data-testid="rail-money" aria-label="Money">
          <div className="tms-rail-money-row"><span>Customer</span><span data-testid="rail-customer-total">{money.priced ? formatCents(money.customerTotalCents) : dash}</span></div>
          <div className="tms-rail-money-row"><span>Carrier</span><span data-testid="rail-carrier-total">{money.carrierTotalCents > 0 ? formatCents(money.carrierTotalCents) : dash}</span></div>
          <div className="tms-rail-money-row tms-rail-net">
            <span>Net <strong data-testid="rail-net">{net}</strong></span>
            <span className="tms-rail-profit" title={money.priced ? `${TONE_WORD[money.tone]} (target ${money.targetPct.toFixed(1)}%)` : undefined}>
              Profit <strong data-testid="rail-profit">{pct}</strong>
              {money.priced ? <span className="tms-rail-dot" data-testid="rail-margin-dot" data-tone={money.tone} role="img" aria-label={TONE_WORD[money.tone]} /> : null}
            </span>
          </div>
        </section>

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

        <ActivityBlock bundle={ctx.bundle} staff={ctx.directory.staff} intakeId={intakeId} intake={intake} />

        <section className="tms-rail-block tms-rail-roles" data-testid="rail-roles" aria-label="Roles">
          <h2 className="tms-rail-h">Roles</h2>
          <Roles value={values.roles} onChange={onRoles} ctx={ctx} form={form} />
        </section>
      </div>

      <div className="tms-rail-actions" data-testid="rail-actions">
        {isDraft ? (
          <TmsButton
            size="sm" data-testid="ship-form-save-draft" disabled={busy || voided} onClick={() => onRun('draft')}
            title={createMode ? 'Autosaves on this browser every 10 s. The first server save consumes a permanent shipment number. ⌘/Ctrl+S' : '⌘/Ctrl+S'}
          >
            Save draft
          </TmsButton>
        ) : null}
        <TmsButton
          size="sm" variant="primary" data-testid={createMode ? 'ship-form-create' : 'ship-form-save'}
          aria-disabled={!ready} data-ready={ready} disabled={busy || voided} onClick={() => onRun(createMode ? 'create' : 'save')}
          title={createMode ? '⌘/Ctrl+Enter' : undefined}
        >
          {createMode ? 'Create shipment' : 'Save changes'}
        </TmsButton>
        {!createMode && status === 'DRAFT' ? (
          <TmsButton size="sm" variant="primary" data-testid="ship-form-submit" disabled={busy || voided} onClick={() => onRun('submit')}>
            Submit order
          </TmsButton>
        ) : null}
        <TmsButton size="sm" variant="ghost" data-testid="ship-form-cancel" onClick={onDiscard}>{createMode ? 'Cancel' : 'Discard'}</TmsButton>
      </div>
    </aside>
  )
}

export const SummaryRail = memo(SummaryRailImpl)
