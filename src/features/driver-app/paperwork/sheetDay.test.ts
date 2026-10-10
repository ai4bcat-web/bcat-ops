import { describe, it, expect } from 'vitest'
import { defaultSheetDay } from './sheetDay'

describe('defaultSheetDay', () => {
  it('shows tomorrow from 8 PM Chicago for Ivan local drivers', () => {
    expect(defaultSheetDay(new Date('2026-10-10T23:30:00Z'), true)).toEqual({ day: '2026-10-10', isTomorrow: false })   // 6:30 PM
    expect(defaultSheetDay(new Date('2026-10-11T01:00:00Z'), true)).toEqual({ day: '2026-10-11', isTomorrow: true })    // 8:00 PM Sat
    expect(defaultSheetDay(new Date('2026-10-11T04:59:00Z'), true)).toEqual({ day: '2026-10-11', isTomorrow: true })    // 11:59 PM Sat
    expect(defaultSheetDay(new Date('2026-10-11T05:00:00Z'), true)).toEqual({ day: '2026-10-11', isTomorrow: false })   // midnight: it is today now
  })
  it('keeps today for everyone else', () => {
    expect(defaultSheetDay(new Date('2026-10-11T01:00:00Z'), false)).toEqual({ day: '2026-10-10', isTomorrow: false })
  })
})
