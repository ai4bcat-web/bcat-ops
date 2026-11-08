/**
 * The summary rail's Activity block (feedback 5): the shipment's stage (chip + compact stepper over
 * the one status ladder in `shipmentStage`) and the last eight audit entries, newest first, each
 * as "time · who · what · field: value". Create mode shows only the Draft chip until the row exists
 * (an intake pre-fill adds the extractor's own entry).
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { buildActivityRows, type AuditRowLike } from '@/lib/auditActivity'
import { STAGE_LABEL, STAGE_LADDER, stageOfBundle } from '@/lib/shipmentStage'
import type { IntakeLoadRecord } from '@/types/intake'
import type { ShipmentBundle, UserProfileRecord } from '@/types/tms'
import { extractionEntry, useShipmentActivity } from './useShipmentActivity'

/** Rows shown before "Show more": keeps Roles and the actions on screen at 1440x900. */
export const COLLAPSED_ROWS = 5

export const AUDIT_PATH = '/tms/brokerage/audit'

export interface ActivityBlockProps {
  bundle: ShipmentBundle | null
  staff: readonly UserProfileRecord[]
  /** The intake item the create page was opened from. */
  intakeId?: string
  intake?: IntakeLoadRecord | null
}

export function ActivityBlock({ bundle, staff, intakeId, intake }: ActivityBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const stage = useMemo(() => stageOfBundle(bundle), [bundle])
  const data = useShipmentActivity(bundle, intakeId)
  const extracted = useMemo(() => (bundle ? null : extractionEntry(intake)), [bundle, intake])

  const rows = useMemo(() => {
    if (!data) return []
    const entries: AuditRowLike[] = [...data.entries, ...(extracted ? [extracted] : [])]
    return buildActivityRows(entries, staff, data.at)
  }, [data, extracted, staff])
  const shown = expanded ? rows : rows.slice(0, COLLAPSED_ROWS)
  const hidden = rows.length - shown.length

  return (
    <section className="tms-rail-block tms-rail-activity" data-testid="rail-activity" aria-label="Activity">
      <h2 className="tms-rail-h">
        Activity
        {bundle ? (
          <Link className="tms-rail-link" data-testid="rail-activity-history" to={`${AUDIT_PATH}?entity=${encodeURIComponent(bundle.shipment.id)}`}>
            Full history
          </Link>
        ) : null}
      </h2>

      <div className="tms-rail-stage" data-testid="rail-stage" data-stage={stage.stage}>
        <span className="tms-rail-chip" data-testid="rail-stage-chip" data-terminal={stage.terminal}>{stage.label}</span>
        {stage.terminal ? null : (
          <ol className="tms-rail-steps" aria-label="Stage">
            {STAGE_LADDER.map((s, i) => (
              <li
                key={s} className="tms-rail-step" data-testid={`rail-step-${s}`} title={STAGE_LABEL[s]}
                data-state={i < stage.step ? 'done' : i === stage.step ? 'current' : 'todo'}
                aria-current={i === stage.step ? 'step' : undefined}
              />
            ))}
          </ol>
        )}
      </div>

      {!bundle && rows.length === 0 ? (
        <p className="tms-rail-empty" data-testid="rail-activity-empty">Activity starts when the shipment is created</p>
      ) : data?.error ? (
        <p className="tms-rail-empty" data-testid="rail-activity-error">Activity could not be loaded</p>
      ) : data === null && bundle ? (
        <p className="tms-rail-empty">Loading activity…</p>
      ) : rows.length === 0 ? (
        <p className="tms-rail-empty" data-testid="rail-activity-empty">No activity yet</p>
      ) : (
        <ol className="tms-rail-acts" data-testid="rail-activity-rows">
          {shown.map((r) => (
            <li key={r.id} className="tms-rail-act" data-testid="rail-activity-row" data-actor-kind={r.actor.kind}>
              <span className="tms-rail-act-time" title={r.timeTitle}>{r.time}</span>
              {' · '}
              <strong className="tms-rail-act-actor" data-testid="rail-activity-actor">{r.actor.label}</strong>
              {' '}
              <span>{r.action}</span>
              {r.detail ? <span className="tms-rail-act-detail" data-testid="rail-activity-detail" title={r.detailTitle || undefined}> · {r.detail}</span> : null}
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 || (expanded && rows.length > COLLAPSED_ROWS) ? (
        <button type="button" className="tms-rail-more" data-testid="rail-activity-more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      ) : null}
    </section>
  )
}
