/**
 * The 150 air-mile short-haul exemption (49 CFR 395.1(e)(1)), measured from Pleasant
 * Prairie, WI. The cases that matter are the two error directions: never tell a driver
 * no logs are needed for a run that left the circle, and never demand logs for a long
 * ROAD trip that stayed inside it.
 */
import { describe, it, expect } from 'vitest'
import {
  assessEld, airMiles, locateCity, normalizeCityKey,
  WORK_REPORTING_LOCATION, SHORT_HAUL_AIR_MILES,
} from './eldRadius'

describe('airMiles', () => {
  it('is zero at the origin', () => {
    expect(airMiles(WORK_REPORTING_LOCATION, WORK_REPORTING_LOCATION)).toBeCloseTo(0, 6)
  })

  it('matches a known distance', () => {
    // Pleasant Prairie → Chicago is about 50 air miles.
    const chicago = locateCity('CHICAGO, IL')!
    expect(airMiles(WORK_REPORTING_LOCATION, chicago)).toBeGreaterThan(45)
    expect(airMiles(WORK_REPORTING_LOCATION, chicago)).toBeLessThan(55)
  })

  it('is symmetric', () => {
    const a = locateCity('MADISON, WI')!
    const b = locateCity('DETROIT, MI')!
    expect(airMiles(a, b)).toBeCloseTo(airMiles(b, a), 9)
  })
})

describe('normalizeCityKey', () => {
  it('accepts the spellings dispatchers actually type', () => {
    for (const raw of ['WAUKEGAN, IL', 'waukegan, il', 'WAUKEGAN IL', 'WAUKEGAN,IL', ' Waukegan ,  IL ']) {
      expect(normalizeCityKey(raw)).toBe('WAUKEGAN, IL')
    }
  })

  it('drops a trailing ZIP', () => {
    expect(normalizeCityKey('KENOSHA, WI 53142')).toBe('KENOSHA, WI')
    expect(normalizeCityKey('LOCKPORT, IL 60441-6603')).toBe('LOCKPORT, IL')
  })

  it('repairs the slips and shorthands in the live data', () => {
    expect(normalizeCityKey('BOOLINGBROOK, IL')).toBe('BOLINGBROOK, IL')
    expect(normalizeCityKey('STURTEVANT.WI')).toBe('STURTEVANT, WI')
    expect(normalizeCityKey('MILWAUKEE')).toBe('MILWAUKEE, WI')
    expect(normalizeCityKey('AMF OHARE, IL')).toBe('CHICAGO, IL')
  })

  it('is nothing for a blank', () => {
    expect(normalizeCityKey('')).toBeNull()
    expect(normalizeCityKey(null)).toBeNull()
  })
})

describe('assessEld', () => {
  it('does not require logs for a run that stays local', () => {
    const a = assessEld(['PLEASANT PRAIRIE, WI', 'CHICAGO, IL'])
    expect(a.status).toBe('NOT_REQUIRED')
    expect(a.farthestMiles).toBeLessThan(SHORT_HAUL_AIR_MILES)
  })

  it('requires logs once a stop is outside the radius', () => {
    const a = assessEld(['CHICAGO, IL', 'MESA, AZ'])
    expect(a.status).toBe('REQUIRED')
    expect(a.farthestCity).toBe('MESA, AZ')
    expect(a.farthestMiles).toBeGreaterThan(1000)
  })

  it('requires logs on the farthest stop even when the rest are local', () => {
    // Leaving the circle once loses the exemption for the day.
    const a = assessEld(['KENOSHA, WI', 'MILWAUKEE, WI', 'HOUSTON, TX', 'RACINE, WI'])
    expect(a.status).toBe('REQUIRED')
    expect(a.farthestCity).toBe('HOUSTON, TX')
  })

  it('does not require logs for a long ROAD trip that stayed inside the circle', () => {
    // Kalamazoo is ~160 road miles but 119 AIR miles — inside. Load.miles would read as
    // over 150 here, which is exactly why road miles must not decide this.
    const a = assessEld(['PLEASANT PRAIRIE, WI', 'KALAMAZOO, MI'])
    expect(airMiles(WORK_REPORTING_LOCATION, locateCity('KALAMAZOO, MI')!)).toBeLessThan(SHORT_HAUL_AIR_MILES)
    expect(a.status).toBe('NOT_REQUIRED')
  })

  it('requires logs for La Crosse-area runs, which are genuinely outside', () => {
    expect(assessEld(['HOLMEN, WI']).status).toBe('REQUIRED')
    expect(assessEld(['LA CROSSE, WI']).status).toBe('REQUIRED')
  })

  it('places Wilmington, IL at the one near Joliet, not the village downstate', () => {
    /*
     * Illinois has two Wilmingtons and they fall on opposite sides of the radius. This is
     * one of the most frequent lanes on these loads, so picking the wrong one would have
     * demanded logs for ~113 stops that are exempt. 75 air miles, not 250.
     */
    const a = assessEld(['WILMINGTON, IL'])
    expect(a.status).toBe('NOT_REQUIRED')
    expect(a.farthestMiles).toBeLessThan(100)
  })

  it('places Kingston, IL at the DeKalb County village', () => {
    // The other duplicated name on these loads that straddles the line.
    expect(assessEld(['KINGSTON, IL']).status).toBe('NOT_REQUIRED')
  })

  it('reports UNKNOWN rather than clearing a city it cannot place', () => {
    // The false negative is the dangerous one: never say "no logs" about an unknown stop.
    const a = assessEld(['CHICAGO, IL', 'CTSI WAREHOUSE'])
    expect(a.status).toBe('UNKNOWN')
    expect(a.unplaceable).toEqual(['CTSI WAREHOUSE'])
  })

  it('still requires logs when a placeable stop is already outside, unknowns or not', () => {
    const a = assessEld(['MESA, AZ', 'CTSI WAREHOUSE'])
    expect(a.status).toBe('REQUIRED')
  })

  it('is UNKNOWN when there is nothing to go on', () => {
    expect(assessEld([]).status).toBe('UNKNOWN')
    expect(assessEld([null, '', undefined]).status).toBe('UNKNOWN')
  })

  it('ignores blanks without calling them unplaceable', () => {
    const a = assessEld(['CHICAGO, IL', '', null])
    expect(a.status).toBe('NOT_REQUIRED')
    expect(a.unplaceable).toEqual([])
  })

  it('names Pleasant Prairie as the reporting location', () => {
    // If this ever moves, the radius moves with it — the name is shown to drivers.
    expect(WORK_REPORTING_LOCATION.name).toBe('Pleasant Prairie, WI')
  })
})

describe('the same stop arriving twice', () => {
  it('does not call a bare city unknown when the load already placed it', () => {
    // The stops array carries "KENOSHA"; the legacy origin carries "KENOSHA, WI".
    const a = assessEld(['KENOSHA', 'KENOSHA, WI'])
    expect(a.status).toBe('NOT_REQUIRED')
    expect(a.unplaceable).toEqual([])
  })

  it('still reports a bare city nothing else placed', () => {
    const a = assessEld(['KENOSHA, WI', 'SOMEWHEREVILLE'])
    expect(a.status).toBe('UNKNOWN')
    expect(a.unplaceable).toEqual(['SOMEWHEREVILLE'])
  })
})
