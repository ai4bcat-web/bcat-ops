import { describe, expect, it } from 'vitest'
import { formatUsDate, parse24Time, parseHoursRange, parseUsDate, splitLocal } from './dateTime24'

const today = new Date(2026, 10, 13) // Nov 13 2026

describe('parseUsDate', () => {
  it('reads month first, with or without a year', () => {
    expect(parseUsDate('11/16/2026', today)).toBe('2026-11-16')
    expect(parseUsDate('11/16/26', today)).toBe('2026-11-16')
    expect(parseUsDate('11/16', today)).toBe('2026-11-16')
    expect(parseUsDate('1-5-2027', today)).toBe('2027-01-05')
    expect(parseUsDate('111626', today)).toBe('2026-11-16')
    expect(parseUsDate('2026-11-16', today)).toBe('2026-11-16')
  })
  it('rolls a year-less date far in the past into next year', () => {
    expect(parseUsDate('1/5', today)).toBe('2027-01-05')
    expect(parseUsDate('10/1', today)).toBe('2026-10-01')
  })
  it('refuses impossible dates and junk', () => {
    expect(parseUsDate('16/11/2026', today)).toBeNull()
    expect(parseUsDate('2/30/2026', today)).toBeNull()
    expect(parseUsDate('soon', today)).toBeNull()
    expect(parseUsDate('', today)).toBeNull()
  })
})

describe('parse24Time', () => {
  it('reads military time in the usual shapes', () => {
    expect(parse24Time('0700')).toBe('07:00')
    expect(parse24Time('700')).toBe('07:00')
    expect(parse24Time('07:00')).toBe('07:00')
    expect(parse24Time('7:00')).toBe('07:00')
    expect(parse24Time('7')).toBe('07:00')
    expect(parse24Time('1530')).toBe('15:30')
    expect(parse24Time('2359')).toBe('23:59')
    expect(parse24Time('0000')).toBe('00:00')
  })
  it('refuses out-of-range times', () => {
    expect(parse24Time('2400')).toBeNull()
    expect(parse24Time('2360')).toBeNull()
    expect(parse24Time('7pm')).toBeNull()
    expect(parse24Time('12345')).toBeNull()
  })
})

describe('helpers', () => {
  it('formats and splits the local value', () => {
    expect(formatUsDate('2026-11-16')).toBe('11/16/2026')
    expect(splitLocal('2026-11-16T07:00')).toEqual({ date: '2026-11-16', time: '07:00' })
    expect(splitLocal('')).toEqual({ date: '', time: '' })
  })
  it('reads a window out of location hours', () => {
    expect(parseHoursRange('FCFS 06:00 TO 15:00')).toEqual({ from: '06:00', to: '15:00' })
    expect(parseHoursRange('7am - 6pm')).toEqual({ from: '07:00', to: '18:00' })
    expect(parseHoursRange('0700-1600')).toEqual({ from: '07:00', to: '16:00' })
    expect(parseHoursRange('Open 7 days')).toBeNull()
    expect(parseHoursRange('')).toBeNull()
  })
})
