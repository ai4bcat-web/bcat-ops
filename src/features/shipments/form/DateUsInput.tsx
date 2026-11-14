/**
 * A date on its own, MM/DD/YYYY: the date half of `DateTime24Input` — typed or picked from our
 * calendar (month first, always). Holds a plain `YYYY-MM-DD`; anything incomplete commits ''.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CalendarDays } from 'lucide-react'
import { TmsInput } from '@/features/tms/kit'
import { formatUsDate, parseUsDate } from '@/lib/dateTime24'
import { CalendarGrid } from './CalendarGrid'
import './form.css'

type DateInputProps = Pick<InputHTMLAttributes<HTMLInputElement>, 'aria-label' | 'id' | 'title'> & { 'data-testid'?: string }

export function DateUsInput({ value, onChange, inputProps, disabled }: {
  /** YYYY-MM-DD or ''. */
  value: string
  onChange: (value: string) => void
  inputProps?: DateInputProps
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(() => (value ? formatUsDate(value) : ''))
  const [open, setOpen] = useState(false)
  const [touched, setTouched] = useState(false)
  const committed = useRef(value)
  const anchor = useRef<HTMLDivElement>(null)

  // A new value from outside (a default changed) replaces the text; our own commits do not.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value
      setDraft(value ? formatUsDate(value) : '')
    }
  }, [value])

  const commit = (text: string) => {
    setDraft(text)
    const d = parseUsDate(text) ?? ''
    if (d !== committed.current) { committed.current = d; onChange(d) }
  }

  const label = inputProps?.['aria-label'] ?? 'Date'
  const testId = inputProps?.['data-testid']
  const bad = touched && draft.trim() !== '' && !parseUsDate(draft)

  return (
    <div className="ship-dt24">
      <div className="ship-dt24-row">
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Anchor asChild>
            <div className="ship-dt24-datebox" ref={anchor}>
              <TmsInput
                {...inputProps} className="ship-dt24-date" inputMode="numeric" autoComplete="off" placeholder="MM/DD/YYYY"
                value={draft} disabled={disabled} aria-invalid={bad || undefined}
                aria-haspopup="dialog" aria-expanded={open}
                onChange={(e) => commit(e.target.value)}
                onBlur={() => { setTouched(true); const d = parseUsDate(draft); if (d) setDraft(formatUsDate(d)) }}
                onClick={() => { if (!disabled) setOpen(true) }}
              />
              <button
                type="button" className="ship-dt24-calbtn" disabled={disabled}
                aria-label={`Choose ${label} date`} data-testid={testId ? `${testId}-calendar` : undefined}
                onClick={() => setOpen(!open)}
              >
                <CalendarDays size={14} />
              </button>
            </div>
          </Popover.Anchor>
          {/* Portaled: in a dialog's scrolling table the calendar must not be clipped. */}
          <Popover.Portal>
          <Popover.Content
            className="tms-portal ship-dt24-pop" align="start" sideOffset={4} aria-label={`${label} calendar`}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => { if (anchor.current?.contains(e.target as Node)) e.preventDefault() }}
          >
            <CalendarGrid value={parseUsDate(draft) ?? ''} onPick={(ymd) => { commit(formatUsDate(ymd)); setTouched(true); setOpen(false) }} />
          </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {bad && <span className="ship-dt24-problem" role="status">Date as MM/DD/YYYY</span>}
    </div>
  )
}
