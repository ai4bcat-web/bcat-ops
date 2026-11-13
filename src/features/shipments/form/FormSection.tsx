/**
 * One numbered card of the shipment form (Step AR): 1 px border, 8 px radius, a 20 px number
 * circle before the title, no header box. The body is always mounted (cards never collapse), so
 * required fields stay in the DOM and keep their focus order.
 */
import { memo, type ReactNode } from 'react'
import type { CardKey } from './cards/cardRegistry'
import type { SectionState } from './sectionSaved'

export interface FormSectionProps {
  id: CardKey
  /** 1-5, the build order. */
  number: number
  title: string
  /** Count of blocking issues inside; 0 hides the badge. */
  errorCount: number
  /** `complete`: only Carrier & Tracking, once the saved load is covered (the card turns green). */
  state?: SectionState
  children: ReactNode
}

function FormSectionImpl({ id, number, title, errorCount, state = 'neutral', children }: FormSectionProps) {
  return (
    <section className={`tms-ship-card tms-ship-card-${id}${state === 'complete' ? ' tms-ship-card--saved' : ''}`}
      data-testid={`section-${id}`} data-state={state} aria-labelledby={`section-${id}-title`}>
      <h2 className="tms-ship-card-head">
        <span className="tms-ship-card-num" aria-hidden="true">{number}</span>
        <span id={`section-${id}-title`} className="tms-ship-card-title">{title}</span>
        {errorCount > 0 ? (
          <span className="tms-ship-card-badge" data-testid={`section-${id}-errors`} aria-label={`${errorCount} problem${errorCount === 1 ? '' : 's'}`}>
            {errorCount}
          </span>
        ) : null}
        {state === 'complete' ? (
          <span className="tms-ship-card-state tms-ship-card-state--saved" data-testid={`section-${id}-saved`}>✓ Covered</span>
        ) : null}
      </h2>
      <div id={`section-${id}-body`} className="tms-ship-card-body">
        {children}
      </div>
    </section>
  )
}

export const FormSection = memo(FormSectionImpl)
