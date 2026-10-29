import { useId } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { cloneElement, isValidElement } from 'react'

export interface TmsFieldProps {
  label: ReactNode
  children: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  className?: string
}

/** Label above a control. The label is wired to the control even when it has no id. */
export function TmsField({ label, children, hint, error, htmlFor, className }: TmsFieldProps) {
  const generated = useId()
  const child = isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null
  const controlId = htmlFor ?? child?.props.id ?? generated
  const control = child && !child.props.id ? cloneElement(child, { id: controlId }) : children

  return (
    <div className={`tms-field${className ? ` ${className}` : ''}`}>
      <label className="tms-field-label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {hint ? <span className="tms-field-hint">{hint}</span> : null}
      {error ? <span className="tms-field-error">{error}</span> : null}
    </div>
  )
}

export default TmsField
