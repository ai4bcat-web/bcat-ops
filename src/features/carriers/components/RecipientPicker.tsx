/**
 * "Send to" for a rate con: tick from the addresses the carrier profile knows, or type
 * another one. Typed addresses become removable chips and are always sent to. The draft
 * text lives in the parent so it can commit (or refuse) a half-typed address on Send.
 */
import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { TmsButton, TmsInput } from '@/features/tms/kit'
import { emailKey } from '@/lib/emailAddress'
import { commitAddress, type RecipientOption } from './rateConRecipients'

export interface RecipientPickerProps {
  options: RecipientOption[]
  selected: string[]
  extras: string[]
  draft: string
  onDraftChange: (text: string) => void
  onSelectedChange: (next: string[]) => void
  onExtrasChange: (next: string[]) => void
  disabled?: boolean
}

export function RecipientPicker({
  options, selected, extras, draft, onDraftChange, onSelectedChange, onExtrasChange, disabled,
}: RecipientPickerProps) {
  const [error, setError] = useState<string | null>(null)
  const isSelected = (email: string) => selected.some((s) => emailKey(s) === emailKey(email))

  const toggle = (email: string, on: boolean) => {
    onSelectedChange(on
      ? [...selected, email]
      : selected.filter((s) => emailKey(s) !== emailKey(email)))
  }

  const add = () => {
    if (!draft.trim()) return
    const result = commitAddress({ text: draft, options, selected, extras })
    if (!result.ok) { setError(result.error); return }
    setError(null)
    onSelectedChange(result.selected)
    onExtrasChange(result.extras)
    onDraftChange('')
  }

  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="text-[10px] font-semibold uppercase tracking-wider tms-muted">Send to</legend>
      {options.length === 0 && extras.length === 0 && (
        <p className="text-xs tms-muted">No e-mail addresses on this carrier's profile — add one below.</p>
      )}
      {options.map((o) => (
        <label key={emailKey(o.email)} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isSelected(o.email)}
            onChange={(e) => toggle(o.email, e.target.checked)}
          />
          <span>{o.email}</span>
          <span className="text-xs tms-muted">{o.label}</span>
        </label>
      ))}
      {extras.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Added addresses">
          {extras.map((x) => (
            <li
              key={emailKey(x)}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs"
              style={{ border: '1px solid var(--tms-border)' }}
            >
              {x}
              <button
                type="button"
                aria-label={`Remove ${x}`}
                onClick={() => onExtrasChange(extras.filter((e) => emailKey(e) !== emailKey(x)))}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <TmsInput
          aria-label="Add another address"
          placeholder="Add another address"
          value={draft}
          onChange={(e) => { setError(null); onDraftChange(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        />
        <TmsButton size="sm" type="button" onClick={add} disabled={!draft.trim()}>
          <Plus size={14} />Add
        </TmsButton>
      </div>
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </fieldset>
  )
}
