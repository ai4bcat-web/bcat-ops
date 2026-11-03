import { segmentShares } from './segmentShares'

export interface TmsSegment {
  key: string
  label: string
  value: number
}

export interface TmsSegmentedBarProps {
  segments: TmsSegment[]
  ariaLabel: string
  formatShare?: (pct: number) => string
  className?: string
}

/** One horizontal bar with the shares above it; segment i uses --tms-chart-{i+1}. */
export function TmsSegmentedBar({ segments, ariaLabel, formatShare = (pct) => `${pct}%`, className }: TmsSegmentedBarProps) {
  const shares = segmentShares(segments.map((s) => s.value))
  const empty = shares.every((s) => s === 0)
  return (
    <div className={`tms-segbar${className ? ` ${className}` : ''}`} role="img" aria-label={ariaLabel}>
      {empty ? (
        <div className="tms-segbar-empty">No data</div>
      ) : (
        <>
          <div className="tms-segbar-legend">
            {segments.map((segment, i) =>
              shares[i] > 0 ? (
                <span key={segment.key} className="tms-segbar-share">
                  <span className="tms-segbar-dot" style={{ background: `var(--tms-chart-${(i % 8) + 1})` }} />
                  <span className="tms-segbar-pct">{formatShare(shares[i])}</span>
                  <span className="tms-segbar-label">{segment.label}</span>
                </span>
              ) : null,
            )}
          </div>
          <div className="tms-segbar-track">
            {segments.map((segment, i) =>
              shares[i] > 0 ? (
                <span
                  key={segment.key}
                  className="tms-segbar-seg"
                  style={{ width: `${shares[i]}%`, background: `var(--tms-chart-${(i % 8) + 1})` }}
                />
              ) : null,
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default TmsSegmentedBar
