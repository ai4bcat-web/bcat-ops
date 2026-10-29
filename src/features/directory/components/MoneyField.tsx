import { useState } from 'react'
import { TmsField, TmsInput } from '@/features/tms/kit'
import { parseCents, formatCents } from '@/lib/tmsDirectory'

export function MoneyField({
  label,
  value,
  onChange,
  error,
  placeholder = '0.00',
  disabled,
}: {
  label?: string
  value?: number | null
  onChange: (cents: number | null) => void
  error?: string
  placeholder?: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const commit = () => {
    const raw = draft.trim()
    if (!raw) {
      onChange(null)
      setDraft('')
      setLocalError(null)
      return
    }
    try {
      const cents = parseCents(raw.replace(/,/g, ''))
      onChange(cents)
      setLocalError(null)
      setDraft('')
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Invalid amount')
    }
  }

  const display = draft || (value != null ? formatCents(value) : '')

  const field = (
    <TmsInput
      type="text"
      inputMode="decimal"
      aria-label={label ? undefined : 'Amount'}
      value={display}
      placeholder={placeholder}
      onFocus={() => {
        if (!draft && value != null) setDraft(formatCents(value))
      }}
      onBlur={() => { commit() }}
      onChange={(e) => setDraft(e.target.value)}
      disabled={disabled}
    />
  )

  if (!label) {
    return (
      <div className="tms-field">
        {field}
        {(error || localError) && <span className="tms-field-error">{error || localError}</span>}
      </div>
    )
  }

  return (
    <TmsField label={label} error={error || localError || undefined}>
      {field}
    </TmsField>
  )
}
