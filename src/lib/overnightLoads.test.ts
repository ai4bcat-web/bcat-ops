/**
 * Which runs count as over-the-road. The cases that matter are the false positives: this
 * decides whether a driver is shown a rate, so a local run must never be mistaken for one.
 */
import { describe, it, expect } from 'vitest'
import { isOvernightPlace, isOvernightLoad } from './overnightLoads'

describe('isOvernightPlace', () => {
  it('matches the shapes that appear on real loads', () => {
    for (const s of ['NEWTON, IA', 'NEWTON IA', 'NEWTON,IA', 'West Des Moines, IA', ' urbandale , ia ']) {
      expect(isOvernightPlace(s)).toBe(true)
    }
  })

  it('matches a bare state code', () => {
    expect(isOvernightPlace('IA')).toBe(true)
  })

  it('does not match another state', () => {
    for (const s of ['CHICAGO, IL', 'MILWAUKEE, WI', 'NEWTON, KS', 'INDIANAPOLIS, IN']) {
      expect(isOvernightPlace(s)).toBe(false)
    }
  })

  it('does not match a city whose NAME contains the state', () => {
    // "Iowa Falls, MN" is not an Iowa run; only the state code decides.
    expect(isOvernightPlace('IOWA FALLS, MN')).toBe(false)
    expect(isOvernightPlace('IOWA CITY, IL')).toBe(false)
  })

  it('does not match a stray "ia" inside a word', () => {
    expect(isOvernightPlace('COLUMBIA, SC')).toBe(false)
    expect(isOvernightPlace('PEORIA, IL')).toBe(false)
  })

  it('is false for nothing', () => {
    expect(isOvernightPlace('')).toBe(false)
    expect(isOvernightPlace(null)).toBe(false)
    expect(isOvernightPlace(undefined)).toBe(false)
  })
})

describe('isOvernightLoad', () => {
  it('counts a run going TO Iowa', () => {
    expect(isOvernightLoad(['CICERO, IL', 'NEWTON, IA'])).toBe(true)
  })

  it('counts a run coming FROM Iowa', () => {
    expect(isOvernightLoad(['URBANDALE, IA', 'CHICAGO, IL'])).toBe(true)
  })

  it('does not count a purely local run', () => {
    expect(isOvernightLoad(['CHICAGO, IL', 'WAUKEGAN, IL'])).toBe(false)
  })

  it('does not count a long run that never touches Iowa', () => {
    /*
     * Holmen, WI is 197 air miles and needs ELD logs, but it is not an Iowa run. The two
     * rules answer different questions and deliberately do not share a definition.
     */
    expect(isOvernightLoad(['PLEASANT PRAIRIE, WI', 'HOLMEN, WI'])).toBe(false)
  })

  it('ignores blanks among real places', () => {
    expect(isOvernightLoad([null, '', 'NEWTON, IA'])).toBe(true)
    expect(isOvernightLoad([null, '', undefined])).toBe(false)
  })
})
