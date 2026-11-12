import { useState } from 'react'
import { X } from 'lucide-react'
import { TmsButton, TmsInput } from '@/features/tms/kit'
import { isValidEmail } from '@/lib/billingMethod'

/**
 * A list of e-mail addresses edited one per row, with "+ Add address" and a remove button on each row.
 * It keeps its own rows (blank ones included) so a freshly added row survives until it is typed in; every
 * change reports the full list of rows, and the caller trims, lowercases and de-duplicates on save.
 */
export function EmailListField({
  initial,
  onChange,
  label,
  placeholder,
  addLabel = '+ Add address',
}: {
  initial: string[]
  onChange: (rows: string[]) => void
  /** Prefix for each row's accessible name: "<label> 1", "<label> 2". */
  label: string
  placeholder?: string
  addLabel?: string
}) {
  const [rows, setRows] = useState<string[]>(() => (initial.length > 0 ? initial : ['']))
  const update = (next: string[]) => {
    const safe = next.length > 0 ? next : ['']
    setRows(safe)
    onChange(safe)
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((row, index) => {
        const bad = row.trim() !== '' && !isValidEmail(row.trim())
        return (
          <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <TmsInput
              value={row}
              placeholder={placeholder}
              aria-label={`${label} ${index + 1}`}
              aria-invalid={bad || undefined}
              onChange={(e) => update(rows.map((r, i) => (i === index ? e.target.value : r)))}
              style={{ flex: 1 }}
            />
            <TmsButton
              size="sm"
              variant="ghost"
              aria-label={`Remove ${label} ${index + 1}`}
              onClick={() => update(rows.filter((_, i) => i !== index))}
            >
              <X size={14} aria-hidden />
            </TmsButton>
          </div>
        )
      })}
      <div>
        <TmsButton size="sm" variant="secondary" onClick={() => update([...rows, ''])}>{addLabel}</TmsButton>
      </div>
    </div>
  )
}
