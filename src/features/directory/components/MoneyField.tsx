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
  grouped,
  prefix,
}: {
  label?: string
  value?: number | null
  onChange: (cents: number | null) => void
  error?: string
  placeholder?: string
  disabled?: boolean
  /** Show thousands separators while the field is not being edited: 1,000,000.00. */
  grouped?: boolean
  /** A leading symbol next to the input, e.g. `$`. */
  prefix?: string
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

  const shownValue = (v: number): string => {
    const text = formatCents(v)
    if (!grouped) return text
    const [whole, fraction] = text.split('.')
    return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
  }
  const display = draft || (value != null ? shownValue(value) : '')

  const input = (
    <TmsInput
      type="text"
      inputMode="decimal"
      aria-label={label && !prefix ? undefined : (label ?? 'Amount')}
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
  const field = prefix ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span aria-hidden="true">{prefix}</span>
      {input}
    </div>
  ) : input

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
