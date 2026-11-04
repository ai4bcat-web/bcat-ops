/** Labelled dense field wired to `labels.ts`: Aljex text, red star when required. */
import type { ReactNode } from 'react'
import { TmsField } from '@/features/tms/kit'
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

/** Label above a control, in Aljex's words; red (`data-required`) with a star when required. */
export function LField({ def, children, error, hint, className, required }: LFieldProps) {
  const req = required ?? def.required
  return (
    <TmsField
      className={`tms-field-dense${className ? ` ${className}` : ''}`}
      label={req ? <span data-required="true">{def.text} *</span> : def.text}
      error={error}
      hint={hint}
    >
      {children}
    </TmsField>
  )
}

