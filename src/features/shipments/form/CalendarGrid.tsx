/**
 * A month calendar for the shipment form's date boxes (Ryne, 2026-11-13): pick a day with the
 * mouse or the keyboard, and the date box shows it as MM/DD/YYYY. Days are plain `YYYY-MM-DD`
 * strings in and out, so no time zone ever touches them.
 *
 * Keyboard: arrows move a day / a week, PageUp/PageDown a month, Home/End the week,
 * Enter or Space picks the day.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays, addMonths, format, isSameMonth, parseISO, startOfMonth, startOfWeek } from 'date-fns'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const ymd = (d: Date) => format(d, 'yyyy-MM-dd')

export function CalendarGrid({ value, onPick, today = new Date(), autoFocus }: {
  /** The picked day (`YYYY-MM-DD`), or '' for none. */
  value: string
  onPick: (ymd: string) => void
  today?: Date
  /** Put keyboard focus on the picked day (or today) when the calendar opens. */
  autoFocus?: boolean
}) {
  const start = value ? parseISO(value) : today
  const [focusDay, setFocusDay] = useState<Date>(start)
  const [month, setMonth] = useState<Date>(startOfMonth(start))
  const grid = useRef<HTMLDivElement>(null)
  const keyboard = useRef(Boolean(autoFocus))

  useEffect(() => {
    if (!keyboard.current) return
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${ymd(focusDay)}"]`)?.focus()
  }, [focusDay, month])

  const moveTo = (d: Date) => {
    keyboard.current = true
    setFocusDay(d)
    if (!isSameMonth(d, month)) setMonth(startOfMonth(d))
  }

  // The arrows page the month without pulling focus off themselves.
  const page = (n: number) => { keyboard.current = false; setMonth(addMonths(month, n)) }

  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      PageUp: () => addMonths(focusDay, -1),
      PageDown: () => addMonths(focusDay, 1),
      Home: () => addDays(focusDay, -focusDay.getDay()),
      End: () => addDays(focusDay, 6 - focusDay.getDay()),
    }
    const next = step[e.key]
    if (!next) return
    e.preventDefault()
    moveTo(next())
  }

  const first = startOfWeek(month)
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i))
  const todayYmd = ymd(today)
  // One day is in the tab order: the focused day, or the 1st when the month was paged away from it.
  const tabbable = isSameMonth(focusDay, month) ? ymd(focusDay) : ymd(month)

  return (
    <div className="ship-cal" ref={grid}>
      <div className="ship-cal-head">
        <button type="button" className="ship-cal-nav" aria-label="Previous month" onClick={() => page(-1)}>
          <ChevronLeft size={14} />
        </button>
        <span className="ship-cal-title" aria-live="polite">{format(month, 'MMMM yyyy')}</span>
        <button type="button" className="ship-cal-nav" aria-label="Next month" onClick={() => page(1)}>
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="ship-cal-grid" role="grid" aria-label={format(month, 'MMMM yyyy')} onKeyDown={onKey}>
        {WEEKDAYS.map((w) => <span key={w} className="ship-cal-dow" role="columnheader">{w}</span>)}
        {days.map((d) => {
          const key = ymd(d)
          return (
            <button
              key={key} type="button" role="gridcell" data-day={key}
              className="ship-cal-day"
              data-outside={isSameMonth(d, month) ? undefined : 'true'}
              data-today={key === todayYmd ? 'true' : undefined}
              aria-selected={key === value}
              aria-label={format(d, 'EEEE, MMMM d, yyyy')}
              tabIndex={key === tabbable ? 0 : -1}
              onClick={() => onPick(key)}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}
