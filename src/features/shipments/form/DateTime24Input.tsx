/**
 * Date + 24-hour time (Ryne, 2026-11-13): US MM/DD/YYYY and military time. The date box opens
 * a calendar (ours, not the browser's, so it always reads month first) and still takes typing;
 * the time stays typed. Holds the same `YYYY-MM-DDTHH:mm` local value a datetime-local input did, so callers
 * and storage are unchanged. A complete, valid pair commits; anything partial commits '' and
 * the text stays so it can be finished. With `endValue` it is an FCFS window: one date, From–To.
 *
 * The date box also takes a pasted `YYYY-MM-DDTHH:mm`, which fills both halves.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CalendarDays } from 'lucide-react'
import { TmsInput } from '@/features/tms/kit'
import { formatUsDate, parse24Time, parseUsDate, splitLocal } from '@/lib/dateTime24'
import { CalendarGrid } from './CalendarGrid'

type DateInputProps = Pick<InputHTMLAttributes<HTMLInputElement>, 'aria-label' | 'id' | 'title'> & { 'data-testid'?: string }

export interface DateTime24InputProps {
  value: string
  onChange: (value: string) => void
  /** Spread on the date box (aria-label, data-testid); the time boxes derive `-time` / `-end` ids from it. */
  inputProps?: DateInputProps
  disabled?: boolean
  /** FCFS window end (`YYYY-MM-DDTHH:mm`, same date as `value`). Present = range mode. */
  endValue?: string
  onEndChange?: (value: string) => void
}

const draftsOf = (value: string, endValue?: string) => {
  const { date, time } = splitLocal(value)
  return { date: date ? formatUsDate(date) : '', time, end: splitLocal(endValue ?? '').time }
}

export function DateTime24Input({ value, onChange, inputProps, disabled, endValue, onEndChange }: DateTime24InputProps) {
  const range = onEndChange !== undefined
  const [draft, setDraft] = useState(() => draftsOf(value, endValue))
  const [touched, setTouched] = useState(false)
  const [open, setOpen] = useState(false)
  // Opened from the calendar button: focus goes into the grid. Opened by clicking the box: it stays in the box for typing.
  const [gridFocus, setGridFocus] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const committed = useRef({ value, end: endValue ?? '' })

  // An outside change (Now, a reload, an intake prefill) resets the text; our own commits don't.
  useEffect(() => {
    if (value !== committed.current.value || (endValue ?? '') !== committed.current.end) {
      committed.current = { value, end: endValue ?? '' }
      setDraft(draftsOf(value, endValue))
      setTouched(false)
    }
  }, [value, endValue])

  const commit = (next: { date: string; time: string; end: string }) => {
    setDraft(next)
    const d = parseUsDate(next.date)
    const t = parse24Time(next.time)
    const v = d && t ? `${d}T${t}` : ''
    if (v !== committed.current.value) { committed.current.value = v; onChange(v) }
    if (range) {
      const e = parse24Time(next.end)
      const ev = d && e ? `${d}T${e}` : ''
      if (ev !== committed.current.end) { committed.current.end = ev; onEndChange?.(ev) }
    }
  }

  const onDate = (text: string) => {
    const pasted = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(text.trim())
    commit(pasted ? { ...draft, date: formatUsDate(pasted[1]), time: pasted[2] } : { ...draft, date: text })
  }

  const pick = (ymd: string) => {
    commit({ ...draft, date: formatUsDate(ymd) })
    setTouched(true)
    setOpen(false)
  }

  const openCalendar = (focusGrid: boolean) => {
    if (disabled) return
    setGridFocus(focusGrid)
    setOpen(true)
  }

  const tidy = () => {
    setTouched(true)
    const d = parseUsDate(draft.date)
    const t = parse24Time(draft.time)
    const e = parse24Time(draft.end)
    setDraft({ date: d ? formatUsDate(d) : draft.date, time: t ?? draft.time, end: e ?? draft.end })
  }

  const badDate = touched && draft.date.trim() !== '' && !parseUsDate(draft.date)
  const badTime = touched && draft.time.trim() !== '' && !parse24Time(draft.time)
  const badEnd = touched && range && draft.end.trim() !== '' && !parse24Time(draft.end)
  const missingTime = touched && draft.date.trim() !== '' && !badDate && draft.time.trim() === ''
  const testId = inputProps?.['data-testid']
  const label = inputProps?.['aria-label'] ?? 'Date'
  const problem = badDate ? 'Date as MM/DD/YYYY' : badTime || badEnd ? '24-hour time, e.g. 0700 or 15:30' : missingTime ? 'Add a time (24-hour)' : null

  return (
    <div className="ship-dt24" data-range={range ? 'true' : undefined}>
      <div className="ship-dt24-row">
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Anchor asChild>
            <div className="ship-dt24-datebox" ref={anchor}>
              <TmsInput
                {...inputProps} className="ship-dt24-date" inputMode="numeric" autoComplete="off" placeholder="MM/DD/YYYY"
                value={draft.date} disabled={disabled} aria-invalid={badDate || undefined}
                aria-haspopup="dialog" aria-expanded={open}
                onChange={(e) => onDate(e.target.value)} onBlur={tidy}
                onClick={() => openCalendar(false)}
                onKeyDown={(e) => { if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openCalendar(true) } }}
              />
              <button
                type="button" className="ship-dt24-calbtn" disabled={disabled}
                aria-label={`Choose ${label} date`} data-testid={testId ? `${testId}-calendar` : undefined}
                onClick={() => (open ? setOpen(false) : openCalendar(true))}
              >
                <CalendarDays size={14} />
              </button>
            </div>
          </Popover.Anchor>
          <Popover.Content
            className="ship-dt24-pop" align="start" sideOffset={4} aria-label={`${label} calendar`}
            onOpenAutoFocus={(e) => e.preventDefault()}
            // A click back in the date box keeps the calendar open; the box toggles it itself.
            onInteractOutside={(e) => { if (anchor.current?.contains(e.target as Node)) e.preventDefault() }}
          >
            <CalendarGrid value={parseUsDate(draft.date) ?? ''} onPick={pick} autoFocus={gridFocus} />
          </Popover.Content>
        </Popover.Root>
        <TmsInput
          className="ship-dt24-time" inputMode="numeric" autoComplete="off" placeholder="HH:MM" maxLength={5}
          aria-label={`${label} ${range ? 'from' : 'time'} (24-hour)`} data-testid={testId ? `${testId}-time` : undefined}
          value={draft.time} disabled={disabled} aria-invalid={badTime || missingTime || undefined}
          onChange={(e) => commit({ ...draft, time: e.target.value })} onBlur={tidy}
        />
        {range && (
          <>
            <span className="ship-dt24-dash" aria-hidden="true">–</span>
            <TmsInput
              className="ship-dt24-time" inputMode="numeric" autoComplete="off" placeholder="HH:MM" maxLength={5}
              aria-label={`${label} to (24-hour)`} data-testid={testId ? `${testId}-end` : undefined}
              value={draft.end} disabled={disabled} aria-invalid={badEnd || undefined}
              onChange={(e) => commit({ ...draft, end: e.target.value })} onBlur={tidy}
            />
          </>
        )}
      </div>
      {problem && <span className="ship-dt24-problem" role="status" data-testid={testId ? `${testId}-problem` : undefined}>{problem}</span>}
    </div>
  )
}
