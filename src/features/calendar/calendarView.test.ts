import { describe, it, expect } from 'vitest'
import { initialCalendarView, rememberPhoneView, effectiveCalendarView } from './calendarView'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
}

describe('calendar view', () => {
  it('opens a desktop and a phone on Day', () => {
    expect(initialCalendarView(false, memory())).toBe('day')
    expect(initialCalendarView(true, memory())).toBe('day')
  })

  it('reopens a phone on the view last picked there', () => {
    const s = memory()
    rememberPhoneView('week', s)
    expect(initialCalendarView(true, s)).toBe('week')
    expect(initialCalendarView(false, s)).toBe('day')
  })

  it('ignores a stored value that is not a view, and storage that throws', () => {
    const s = memory(); s.setItem('calendar.phoneView.v2', 'agenda')
    expect(initialCalendarView(true, s)).toBe('day')
    expect(initialCalendarView(true, { getItem: () => { throw new Error('blocked') } })).toBe('day')
  })

  it('drops a List remembered under the old key', () => {
    const s = memory(); s.setItem('calendar.phoneView', 'list')
    expect(initialCalendarView(true, s)).toBe('day')
  })

  it('shows List only on a phone', () => {
    expect(effectiveCalendarView('list', true)).toBe('list')
    expect(effectiveCalendarView('list', false)).toBe('day')
    expect(effectiveCalendarView('month', false)).toBe('month')
  })
})
