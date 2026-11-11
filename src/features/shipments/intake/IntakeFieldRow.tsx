import type { ReactNode } from 'react'
import { TmsBadge, TmsField } from '@/features/tms/kit'
import type { TmsTone } from '@/features/tms/kit'
import type { IntakeFieldStatus, IntakeSource } from '@/types/intake'
import './intake.css'

const CHIPS: Record<IntakeFieldStatus, { label: string; tone: TmsTone }> = {
  AUTO: { label: 'Auto-filled', tone: 'green' },
  LOW: { label: 'Check this', tone: 'orange' },
  MISSING: { label: 'Missing', tone: 'red' },
  CONFIRMED: { label: 'Confirmed', tone: 'blue' },
  INVALID: { label: 'Invalid', tone: 'red' },
}

const SOURCES: Record<IntakeSource, string> = {
  PARSER: 'Read from the e-mail by the tender parser',
  MODEL: 'Filled by the AI agent from the e-mail',
  RATECON: 'Read from the attached rate confirmation',
  DIRECTORY: 'Matched in the directory',
  ADDRESS: 'Taken from the address the e-mail arrived at',
  DEFAULT: "The customer's default",
  REVIEWER: 'Entered by a reviewer',
}

export interface IntakeFieldRowProps {
  label: string
  status: IntakeFieldStatus
  source?: IntakeSource | null
  /** The control (TmsInput / TmsSelect / picker). */
  children: ReactNode
  /** Set when the row is read-only for this viewer; the confirm checkbox is disabled too. */
  disabled?: boolean
  /** A LOW field shows a confirm tick; called with the new ticked state. */
  onConfirm?: (checked: boolean) => void
  hint?: ReactNode
  /** A field the load cannot be created without: a red asterisk after the label. */
  required?: boolean
}

/** One labelled field with its status chip, a `title` naming where the value came from, and the confirm tick for LOW. */
export function IntakeFieldRow({ label, status, source, children, disabled, onConfirm, hint, required }: IntakeFieldRowProps) {
  const chip = CHIPS[status]
  const title = source ? SOURCES[source] : status === 'MISSING' ? 'Nothing in the e-mail filled this' : undefined
  return (
    <div className="tms-intake-row" data-status={status}>
      <TmsField label={required ? <>{label}<span className="tms-fg-star" aria-hidden="true"> *</span></> : label} hint={hint}>
        {children}
      </TmsField>
      <div className="tms-intake-row-status">
        <TmsBadge tone={chip.tone} title={title}>{chip.label}</TmsBadge>
        {status === 'LOW' && onConfirm ? (
          <label className="tms-intake-confirm">
            <input
              type="checkbox"
              aria-label={`Confirm ${label}`}
              disabled={disabled}
              checked={false}
              onChange={(e) => onConfirm(e.target.checked)}
            />
            Confirm
          </label>
        ) : null}
      </div>
    </div>
  )
}

export default IntakeFieldRow
