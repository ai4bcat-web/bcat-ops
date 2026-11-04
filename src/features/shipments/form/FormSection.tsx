/**
 * One collapsible card of the shipment form (AH-plan §6). Collapsing never unmounts the body
 * (`hidden` + `inert`), so values, focus order and collapsed required fields all survive.
 */
import { memo, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { SectionKey } from './sectionProps'

export interface FormSectionProps {
  id: SectionKey
  title: string
  open: boolean
  onToggle: (id: SectionKey) => void
  /** Count of blocking issues inside; 0 hides the badge. */
  errorCount: number
  children: ReactNode
}

function FormSectionImpl({ id, title, open, onToggle, errorCount, children }: FormSectionProps) {
  const bodyId = `section-${id}-body`
  return (
    <section className={`tms-ship-section tms-ship-section-${id}`} data-testid={`section-${id}`} data-open={open}>
      <h2 className="tms-ship-section-head">
        <button
          type="button"
          className="tms-ship-section-toggle"
          data-testid={`section-${id}-toggle`}
          data-section-toggle={id}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggle(id)}
          onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); onToggle(id) } }}
        >
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span>{title}</span>
        </button>
        {errorCount > 0 ? (
          <span className="tms-ship-section-badge" data-testid={`section-${id}-errors`} aria-label={`${errorCount} problem${errorCount === 1 ? '' : 's'}`}>
            {errorCount}
          </span>
        ) : null}
      </h2>
      <div id={bodyId} className="tms-ship-section-body" hidden={!open} inert={!open}>
        {children}
      </div>
    </section>
  )
}

export const FormSection = memo(FormSectionImpl)
