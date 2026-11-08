/**
 * One field of the 12-column grid (feedback 10): ONE label line (11 px caps, fixed height, never
 * wraps), the control (32 px) and NOTHING underneath. Helper copy is an ⓘ tooltip on the label and a
 * `title` on the field; an error is a red outline plus the label tooltip (its text stays in the DOM,
 * visually hidden, for screen readers). Required is the green treatment on the wrapper plus `aria`.
 */
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import './fieldGrid.css'

export interface FieldProps {
  label: ReactNode
  /** Columns of 12 at wide widths: 2, 3, 4, 6, 9 or 12. */
  span: number
  /** Columns at narrow widths; default: 6 for a quarter/third field, 12 for 6 or more. */
  narrow?: number
  /** Helper copy: shown in the ⓘ tooltip and the field's `title`, never under the input. */
  info?: string
  /** A short marker in the label row after the text ("est."), never under the input. */
  aside?: ReactNode
  /** The ONLY allowed element under a control: a fixed-height character counter on a notes textarea. */
  footer?: ReactNode
  error?: string
  required?: boolean
  htmlFor?: string
  className?: string
  children: ReactNode
}

export function Field({ label, span, narrow, info, aside, footer, error, required, htmlFor, className, children }: FieldProps) {
  const generated = useId()
  const child = isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null
  const controlId = htmlFor ?? child?.props.id ?? generated
  const control = child && !child.props.id ? cloneElement(child, { id: controlId }) : children
  const tip = [info, error].filter(Boolean).join(' · ') || undefined
  return (
    <div
      className={`tms-fg-field${required ? ' tms-field-req' : ''}${className ? ` ${className}` : ''}`}
      data-span={span} data-span-narrow={narrow ?? ''} data-invalid={error ? 'true' : undefined} title={tip}
    >
      <label className="tms-fg-label" htmlFor={controlId}>
        <span className="tms-fg-label-text">{label}</span>
        {aside}
        {info ? <Info size={11} className="tms-fg-info" aria-hidden="true" /> : null}
      </label>
      <div className="tms-fg-control">{control}</div>
      {footer ? <div className="tms-fg-counter">{footer}</div> : null}
      {info ? <span className="tms-fg-sr">{info}</span> : null}
      {error ? <span className="tms-fg-sr" role="alert">{error}</span> : null}
    </div>
  )
}
