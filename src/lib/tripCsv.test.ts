import { describe, it, expect } from 'vitest'
import { parseRows, detectMultiLoadBlocks } from './tripCsv'

// Real Amazon Relay "Trips" export header + rows (truncated after Currency), incl. the
// leading UTF-8 BOM. Locks the column mapping to the actual export format.
const HEADER = '﻿Block ID,Trip ID,Block/Trip,Trip Stage,Load ID,Facility Sequence,Load Execution Status,Transit Operator Type,Driver Name,Equipment Type,Trailer ID,Tractor Vehicle ID,Estimate Distance,Unit,Rate Type,Estimated Cost,Currency'
const ROW_CHAD = ",111Y19HML,Trip,Completed,111Y19HML,GYR3->FTW6,Completed,Single Driver,Chad Salerno,53' Trailer,HV2501487,P1343771,1068.61,mi,PER_LOAD,5248.52,USD"
const ROW_MIKE = ",T-1121TPV6X,Trip,Completed,112Y7ZWKD,TUS2->GEU3,Completed,Single Driver,Michael Bodle,53' Trailer,,ALC324929,150.35,mi,PER_LOAD,97.81,USD"

describe('parseRows — real Amazon Relay export', () => {
  it('maps the Amazon columns correctly', () => {
    const rows = parseRows([HEADER, ROW_CHAD, ROW_MIKE].join('\n'))
    expect(rows).toHaveLength(2)

    const chad = rows[0]
    expect(chad.driverName).toBe('Chad Salerno')      // routes the master CSV
    expect(chad.loadId).toBe('111Y19HML')
    expect(chad.freightAmount).toBe(5248.52)           // ← Estimated Cost
    expect(chad.miles).toBe(1068.61)                   // ← Estimate Distance
    expect(chad.equipment).toBe("53' Trailer")
    expect(chad.origin).toBe('GYR3')                   // ← Facility Sequence split
    expect(chad.destination).toBe('FTW6')
    expect(chad.status).toBe('Completed')
    expect(chad.ratePerMile).toBeCloseTo(5248.52 / 1068.61, 2)  // derived

    expect(rows[1].driverName).toBe('Michael Bodle')
    expect(rows[1].freightAmount).toBe(97.81)
    expect(rows[1].origin).toBe('TUS2')
    expect(rows[1].destination).toBe('GEU3')
  })

  it('still parses a simple positional paste (no header)', () => {
    const rows = parseRows("112CRP7T7\tUPRR->ELP1\t\t40.73\t53' Container\t$300.00\t\tLee Lara\tCompleted")
    expect(rows).toHaveLength(1)
    expect(rows[0].loadId).toBe('112CRP7T7')
    expect(rows[0].freightAmount).toBe(300)
    expect(rows[0].driverName).toBe('Lee Lara')        // dispatcher column when no Driver col
  })

  it('skips rows with no numeric cost', () => {
    const rows = parseRows([HEADER, ',,,,,,,,Nobody,,,,,,,,'].join('\n'))
    expect(rows).toHaveLength(0)
  })

  it('extracts the trip start date when the export carries one', () => {
    const H = 'Driver Name,Estimated Cost,Scheduled Start Time,Facility Sequence'
    const rows = parseRows([
      H,
      'Lee Lara,300.00,2026-06-08 14:30 PDT,UPRR->ELP1',
      'Mike Bodle,97.81,6/9/2026 06:00,TUS2->GEU3',
    ].join('\n'))
    expect(rows[0].date).toBe('2026-06-08')
    expect(rows[1].date).toBe('2026-06-09')
  })

  it('leaves date null when no date column exists', () => {
    const rows = parseRows([HEADER, ROW_CHAD].join('\n'))
    expect(rows[0].date).toBeNull()
  })

  it('captures the Trip ID column', () => {
    const rows = parseRows([HEADER, ROW_CHAD, ROW_MIKE].join('\n'))
    expect(rows[0].tripId).toBe('111Y19HML')
    expect(rows[1].tripId).toBe('T-1121TPV6X')
  })
})

describe('detectMultiLoadBlocks — guardrail for understated block pay', () => {
  it('flags a "T-" trip id as a block', () => {
    const rows = parseRows([HEADER, ROW_CHAD, ROW_MIKE].join('\n'))
    const b = detectMultiLoadBlocks(rows)
    expect(b.blockTripIds).toEqual(['T-1121TPV6X'])
    expect(b.legRows).toBe(1)
  })

  it('flags a repeated trip id (multiple loads, no T- prefix) as a block', () => {
    const H = 'Trip ID,Load ID,Estimated Cost,Driver Name'
    const rows = parseRows([
      H,
      'BLOCK9,L1,76.72,Michael Bodle',
      'BLOCK9,L2,33.26,Michael Bodle',
      '111SOLO,111SOLO,533.88,Michael Bodle',
    ].join('\n'))
    const b = detectMultiLoadBlocks(rows)
    expect(b.blockTripIds).toEqual(['BLOCK9'])
    expect(b.legRows).toBe(2)
  })

  it('returns no blocks for all single loads', () => {
    const H = 'Trip ID,Load ID,Estimated Cost,Driver Name'
    const rows = parseRows([H, '111SOLO,111SOLO,533.88,Mike', '112SOLO,112SOLO,410.69,Mike'].join('\n'))
    expect(detectMultiLoadBlocks(rows).blockTripIds).toEqual([])
  })
})
