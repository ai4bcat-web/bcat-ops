import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

export interface TmsTimelineItem {
  id: string
  title: ReactNode
  tag?: ReactNode
  description?: ReactNode
  at?: ReactNode
  tone?: 'green' | 'orange' | 'red' | 'blue' | 'gray'
  state?: 'done' | 'current' | 'upcoming'
  testId?: string
}

export interface TmsTimelineProps {
  items: TmsTimelineItem[]
  compact?: boolean
  ariaLabel?: string
  /** Rendered instead of the list when `items` is empty. */
  empty?: ReactNode
  className?: string
  'data-testid'?: string
}

/** Vertical timeline: done = filled node with a check, current = ringed, upcoming = hollow. */
export function TmsTimeline({ items, compact, ariaLabel, empty, className, 'data-testid': testId }: TmsTimelineProps) {
  if (items.length === 0) return <>{empty ?? null}</>
  return (
    <ol
      className={`tms-timeline${compact ? ' tms-timeline-compact' : ''}${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {items.map((item) => {
        const state = item.state ?? 'done'
        return (
          <li
            key={item.id}
            className={`tms-timeline-item${item.tone ? ` tms-timeline-${item.tone}` : ''}`}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            data-testid={item.testId}
          >
            <span className="tms-timeline-node" aria-hidden="true">
              {state === 'done' && !item.tone ? <Check size={12} strokeWidth={3} /> : null}
            </span>
            <div className="tms-timeline-body">
              <div className="tms-timeline-head">
                <span className="tms-timeline-title">{item.title}</span>
                {item.tag ? <span className="tms-timeline-tag">{item.tag}</span> : null}
                {item.at ? <span className="tms-timeline-at">{item.at}</span> : null}
              </div>
              {item.description ? <div className="tms-timeline-desc">{item.description}</div> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export default TmsTimeline
