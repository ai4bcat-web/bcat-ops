import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { parseCents, formatCents } from '@/lib/tmsDirectory'

export function MoneyField({
  label,
  value,
  onChange,
  error,
  placeholder = '0.00',
}: {
  label: string
  value?: number | null
  onChange: (cents: number | null) => void
  error?: string
  placeholder?: string
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

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</Label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
        <Input
          type="text"
          inputMode="decimal"
          aria-label={label}
          value={display}
          placeholder={placeholder}
          onFocus={() => {
            if (!draft && value != null) setDraft(formatCents(value))
          }}
          onBlur={() => { commit() }}
          onChange={(e) => setDraft(e.target.value)}
          className="h-9 pl-7 text-sm"
        />
      </div>
      {(error || localError) && <p className="text-xs text-destructive">{error || localError}</p>}
    </div>
  )
}
