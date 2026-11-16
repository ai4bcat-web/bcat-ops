import { useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { isEmailAddress, splitEmailText } from '@/lib/apEmails'

/**
 * Several e-mail addresses in one box, one chip each (Ryne 2026-11-16, 14815 WHIMSY). Typing a comma, semicolon,
 * space or Enter/Tab, pasting a list, or leaving the box turns the text into chips. A chip that is not an address
 * shows red and stays in the list, so the form's validation refuses the save instead of dropping it silently.
 * Backspace in an empty box removes the last chip.
 */
export function EmailChipsInput({
  value,
  onChange,
  label,
  placeholder = 'ap@customer.com',
  disabled = false,
  id,
}: {
  value: readonly string[]
  onChange: (list: string[]) => void
  label: string
  placeholder?: string
  disabled?: boolean
  id?: string
}) {
  const [draft, setDraft] = useState('')

  const commit = (text: string) => {
    const added = splitEmailText(text)
    setDraft('')
    if (added.length === 0) return
    const next = [...value]
    for (const email of added) if (!next.includes(email)) next.push(email)
    onChange(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ' || (e.key === 'Tab' && draft.trim())) && draft.trim()) {
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault()
      commit(`${draft} ${text}`)
    }
  }

  return (
    <div
      className="tms-email-chips"
      data-testid="email-chips"
      style={{
        display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minHeight: 40, padding: '4px 8px',
        border: '1px solid var(--tms-input-border, var(--tms-border))', borderRadius: 8, background: 'var(--tms-input, var(--tms-surface))',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {value.map((email) => {
        const bad = !isEmailAddress(email)
        return (
          <span
            key={email}
            data-testid="email-chip"
            data-invalid={bad || undefined}
            title={bad ? 'Not a valid e-mail address' : email}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 13,
              background: bad ? 'var(--tms-badge-red-tint)' : 'var(--tms-badge-blue-tint)',
              color: bad ? 'var(--tms-badge-red)' : 'inherit',
              border: bad ? '1px solid var(--tms-badge-red)' : '1px solid transparent',
            }}
          >
            {email}
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove ${email}`}
                onClick={() => onChange(value.filter((v) => v !== email))}
                style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', color: 'inherit' }}
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </span>
        )
      })}
      <input
        id={id}
        aria-label={label}
        value={draft}
        disabled={disabled}
        placeholder={value.length === 0 ? placeholder : 'Add another…'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => draft.trim() && commit(draft)}
        style={{ flex: '1 1 160px', minWidth: 120, border: 0, outline: 'none', background: 'transparent', font: 'inherit', padding: '4px 0' }}
      />
    </div>
  )
}
