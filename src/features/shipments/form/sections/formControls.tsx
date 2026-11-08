/** Labelled dense field wired to `labels.ts`: Aljex text; required fields are green-tinted (no asterisk). */
import { useContext, type ReactNode } from 'react'
import { Field } from '../fieldGrid'
import { FromEmailContext } from '../fromEmail'
import type { LabelDef } from '../labels'
import './sections.css'

interface LFieldProps {
  def: LabelDef
  children: ReactNode
  error?: string
  /** Helper copy: an ⓘ tooltip on the label and the field's title, never text under the input. */
  hint?: ReactNode
  className?: string
  /** Overrides `def.required` (a stop's Ready is red only on the Pick Up). */
  required?: boolean
  /** Columns of the 12-column grid at wide widths (default: the whole row). */
  span?: number
  /** Columns when the card is narrow (see fieldGrid/rowsOf). */
  narrow?: number
}

/** Label above a control, in Aljex's words; `tms-field-req` on the wrapper turns its inputs green when required. */
export function LField({ def, children, error, hint, className, required, span = 12, narrow }: LFieldProps) {
  const req = required ?? def.required
  const fromEmail = useContext(FromEmailContext).has(def.testId)
  return (
    <Field
      className={`tms-field-dense${fromEmail ? ' tms-field-from-email' : ''}${className ? ` ${className}` : ''}`}
      span={span} narrow={narrow} required={req} error={error} info={typeof hint === 'string' ? hint : undefined} aside={typeof hint === 'string' ? undefined : hint}
      label={fromEmail ? <>{def.text}<span className="tms-from-email" data-testid={`${def.testId}-from-email`} title="Filled from the e-mail / rate confirmation. Check it.">from e-mail</span></> : def.text}
    >
      {children}
    </Field>
  )
}
