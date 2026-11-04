/** Labelled dense field wired to `labels.ts`: Aljex text; required fields are green-tinted (no asterisk). */
import { useContext, type ReactNode } from 'react'
import { TmsField } from '@/features/tms/kit'
import { FromEmailContext } from '../fromEmail'
import type { LabelDef } from '../labels'
import './sections.css'

interface LFieldProps {
  def: LabelDef
  children: ReactNode
  error?: string
  hint?: ReactNode
  className?: string
  /** Overrides `def.required` (a stop's Ready is red only on the Pick Up). */
  required?: boolean
}

/** Label above a control, in Aljex's words; `tms-field-req` on the wrapper turns its inputs green when required. */
export function LField({ def, children, error, hint, className, required }: LFieldProps) {
  const req = required ?? def.required
  const fromEmail = useContext(FromEmailContext).has(def.testId)
  return (
    <TmsField
      className={`tms-field-dense${req ? ' tms-field-req' : ''}${fromEmail ? ' tms-field-from-email' : ''}${className ? ` ${className}` : ''}`}
      label={fromEmail ? <>{def.text}<span className="tms-from-email" data-testid={`${def.testId}-from-email`} title="Filled from the e-mail / rate confirmation. Check it.">from e-mail</span></> : def.text}
      error={error}
      hint={hint}
    >
      {children}
    </TmsField>
  )
}

