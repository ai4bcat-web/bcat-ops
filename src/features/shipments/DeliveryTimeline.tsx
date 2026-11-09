/**
 * The delivery timeline (feedback 12): five checkpoints on one line, a small truck on the line at
 * the current phase. Reached dots and segments are accent green, upcoming ones grey, a late or
 * exception truck is amber (the reason on hover), a voided timeline is struck through. The caption
 * above the line is the label row of the header strip's rhythm ("Stop 2 of 4" / "Not dispatched" /
 * "Draft"). role="img" with a text summary; hovering the truck shows the last position and time,
 * hovering a checkpoint its timestamp. Static SVG, tokens only (no keyframes).
 */
import { memo } from 'react'
import { formatBoardDateTime } from '@/lib/date'
import { PHASE_LABEL, type PhaseResult } from '@/lib/deliveryPhase'
import './deliveryTimeline.css'

const X0 = 28
const STEP = 66
const Y = 20
const dotX = (n: number) => X0 + n * STEP
const PARKED_X = 10

/** Where the truck is drawn: parked left of the first dot until the load is at the pickup. */
function truckX(r: PhaseResult): number {
  if (r.phase === 'DRAFT' || r.phase === 'NOT_COVERED' || r.phase === 'COVERED' || r.phase === 'RC_SENT' || r.phase === 'DISPATCHED' || r.phase === 'NOT_DISPATCHED' || r.phase === 'EN_ROUTE_PICKUP' || r.phase === 'VOIDED') return PARKED_X
  return dotX(r.truckAt)
}

function truckTitle(r: PhaseResult): string {
  const lines: string[] = [PHASE_LABEL[r.phase]]
  if (r.lastFix) lines.push(`Last position${r.lastFix.place ? ` ${r.lastFix.place}` : ''}, ${formatBoardDateTime(r.lastFix.at)}`)
  if (r.reason) lines.push(r.reason)
  return lines.join('\n')
}

function DeliveryTimelineImpl({ result: r }: { result: PhaseResult }) {
  const x = truckX(r)
  const moving = r.phase === 'IN_TRANSIT' || r.phase === 'DEPARTED'
  const caption = r.caption ? `${r.caption}` : r.label
  const showPhase = r.caption && !/^(Draft|Not covered|Covered|RC sent|Dispatched|Not dispatched|Voided)$/.test(r.caption)
  return (
    <div className="tms-dt" data-testid="delivery-timeline" data-phase={r.phase} data-tone={r.tone} data-voided={r.phase === 'VOIDED'}>
      <span className="tms-fg-label" data-testid="delivery-caption">
        <span className="tms-fg-label-text">{showPhase ? `${r.label} · ${caption}` : caption}</span>
      </span>
      <svg
        className="tms-dt-svg" viewBox="0 0 304 32" width="304" height="32" role="img" aria-label={r.summary} data-testid="delivery-timeline-svg"
      >
        {CHECKPOINT_X.slice(0, -1).map((from, n) => (
          <line key={n} className="tms-dt-seg" data-on={r.checkpoints[n + 1]?.reached ? 'true' : 'false'} x1={from} y1={Y} x2={CHECKPOINT_X[n + 1]} y2={Y} data-testid={`dt-seg-${n}`} />
        ))}
        {moving ? <line className="tms-dt-motion" x1={Math.max(X0, x - 34)} y1={Y} x2={x - 12} y2={Y} /> : null}
        {r.checkpoints.map((c, n) => (
          <g key={c.key} data-testid={`dt-cp-${c.key}`} data-reached={c.reached}>
            <title>{c.reached && c.at ? `${c.label}: ${formatBoardDateTime(c.at)}` : c.reached ? `${c.label}: reached` : `${c.label}: not yet`}</title>
            <circle className="tms-dt-dot" data-on={c.reached ? 'true' : 'false'} cx={dotX(n)} cy={Y} r={4} />
          </g>
        ))}
        <g className="tms-dt-truck" data-tone={r.tone} data-testid="dt-truck" transform={`translate(${x - 10} ${Y - 15})`}>
          <title>{truckTitle(r)}</title>
          <rect className="tms-dt-truck-body" x="0" y="3" width="13" height="9" rx="1" />
          <path className="tms-dt-truck-body" d="M13 6 h4 l3 3 v3 h-7 z" />
          <circle className="tms-dt-wheel" cx="5" cy="13" r="2" />
          <circle className="tms-dt-wheel" cx="16" cy="13" r="2" />
        </g>
        {r.phase === 'VOIDED' ? <line className="tms-dt-strike" x1={4} y1={Y} x2={300} y2={Y} data-testid="dt-strike" /> : null}
      </svg>
    </div>
  )
}

const CHECKPOINT_X = [0, 1, 2, 3, 4].map(dotX)

export const DeliveryTimeline = memo(DeliveryTimelineImpl)
