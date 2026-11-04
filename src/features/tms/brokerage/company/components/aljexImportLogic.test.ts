import { describe, it, expect } from 'vitest'
import { ALJEX_HEADERS_V1 } from '@/lib/aljex/layout'
import { DEFAULT_ALJEX_PROFILE } from '@/lib/aljex/profile'
import type { AljexImportJob, AljexStageSummary } from '@/types/tms'
import {
  applyBlockReason, blockingOf, centsFromTyped, detectLayout, furthestStep, isStalled, parseHeaderRecord, sampleCell,
  planBlockReason, progressOf, unmappedFor,
} from './aljexImportLogic'

const job = (over: Partial<AljexImportJob> = {}): AljexImportJob => ({ id: 'aljexrun:1', status: 'PLANNED', createdBy: 'a@b.c', ...over })
const NOW = Date.parse('2026-11-03T12:00:00Z')

describe('layout detection', () => {
  const csv = `${ALJEX_HEADERS_V1.map((h) => `"${h.replace(/"/g, '""')}"`).join(',')}\n"1","2"\n`

  it('reads only the first record, through a BOM and quoted commas, and matches the 486-column layout', () => {
    const headers = parseHeaderRecord(`\uFEFF${csv}`)
    expect(headers).toEqual([...ALJEX_HEADERS_V1])
    expect(detectLayout(headers)).toMatchObject({ matches: true, headerCount: 486, mismatchedColumns: [] })
  })

  it('does not match when a column is missing or a sentinel header changed, and names the column', () => {
    expect(detectLayout(ALJEX_HEADERS_V1.slice(0, 485)).matches).toBe(false)
    const swapped = [...ALJEX_HEADERS_V1]
    swapped[1] = 'Something else'
    const result = detectLayout(swapped)
    expect(result.matches).toBe(false)
    expect(result.mismatchedColumns).toContain(2)
  })

  it('keeps an escaped quote and a comma inside one cell', () => {
    expect(parseHeaderRecord('"a ""b"", c",d\r\n"x"')).toEqual(['a "b", c', 'd'])
  })
})

describe('isStalled', () => {
  it('flags a RUNNING job whose heartbeat is older than 3 minutes, never a PAUSED or fresh one', () => {
    expect(isStalled({ status: 'RUNNING', heartbeatAt: '2026-11-03T11:56:59Z' }, NOW)).toBe(true)
    expect(isStalled({ status: 'RUNNING', heartbeatAt: '2026-11-03T11:57:30Z' }, NOW)).toBe(false)
    expect(isStalled({ status: 'PAUSED', heartbeatAt: '2026-11-03T10:00:00Z' }, NOW)).toBe(false)
  })
  it('falls back to startedAt when no heartbeat was ever written', () => {
    expect(isStalled({ status: 'RUNNING', startedAt: '2026-11-03T11:00:00Z' }, NOW)).toBe(true)
    expect(isStalled({ status: 'RUNNING' }, NOW)).toBe(false)
  })
})

describe('unmapped values drive the gates', () => {
  const stage = {
    rows: 10, loads: 9, memos: 1, junkDates: 0, duplicatePros: 0, raggedRows: 0, parseErrors: 0,
    distinct: {
      status: [{ value: 'OPEN', count: 5 }, { value: 'MYSTERY', count: 2 }],
      typeOfShipment: [{ value: 'DEBT', count: 1 }],
      salesreps: [{ value: '005', count: 4 }],
    },
  } satisfies AljexStageSummary

  it('an unknown status blocks; an unmapped rep is only listed; a DEBT memo type never blocks', () => {
    const unmapped = unmappedFor(DEFAULT_ALJEX_PROFILE, stage)
    expect(blockingOf(unmapped).map((u) => u.value)).toEqual(['MYSTERY'])
    expect(unmapped.some((u) => u.column === 'salesrep' && !u.blocking)).toBe(true)
  })

  it('mapping the value on the edited profile unblocks it without a server round trip', () => {
    const edited = { ...DEFAULT_ALJEX_PROFILE, statusMap: { ...DEFAULT_ALJEX_PROFILE.statusMap, MYSTERY: DEFAULT_ALJEX_PROFILE.statusMap.OPEN } }
    expect(blockingOf(unmappedFor(edited, stage))).toEqual([])
  })
})

describe('planBlockReason', () => {
  it.each([
    [{ job: null, blockingUnmapped: 0, profileDirty: false }, /Upload a file/],
    [{ job: job({ status: 'RUNNING' }), blockingUnmapped: 0, profileDirty: false }, /cannot be planned/],
    [{ job: job({ status: 'READY' }), blockingUnmapped: 0, profileDirty: true }, /Save the profile/],
    [{ job: job({ status: 'READY' }), blockingUnmapped: 2, profileDirty: false }, /2 values/],
  ])('refuses %#', (input, message) => {
    expect(planBlockReason(input)).toMatch(message)
  })
  it('allows a READY job with a saved, fully mapped profile (and a re-plan of a PLANNED one)', () => {
    expect(planBlockReason({ job: job({ status: 'READY' }), blockingUnmapped: 0, profileDirty: false })).toBeNull()
    expect(planBlockReason({ job: job({ status: 'PLANNED' }), blockingUnmapped: 0, profileDirty: false })).toBeNull()
  })
})

describe('applyBlockReason', () => {
  const base = {
    job: job(), blockingUnmapped: 0, profileDirty: false, plannedProfileVersion: 3, savedProfileVersion: 3,
    target: 'REHEARSAL' as const, tag: 'rh1103', synthetic: false, rehearsalGate: null,
  }

  it('is open for a planned job on a rehearsal copy with a valid tag', () => {
    expect(applyBlockReason(base)).toBeNull()
  })

  it('stays closed until the job is PLANNED and nothing is unmapped', () => {
    expect(applyBlockReason({ ...base, job: job({ status: 'READY' }) })).toMatch(/Plan the import first/)
    expect(applyBlockReason({ ...base, blockingUnmapped: 1 })).toMatch(/1 unmapped value block/)
  })

  it('closes when the profile was saved after the plan ran', () => {
    expect(applyBlockReason({ ...base, savedProfileVersion: 4 })).toMatch(/Plan again/)
    expect(applyBlockReason({ ...base, profileDirty: true })).toMatch(/plan again/)
  })

  it('rejects a malformed rehearsal tag', () => {
    for (const tag of ['', 'AB', 'has space', 'toolongtagvalue']) expect(applyBlockReason({ ...base, tag })).toMatch(/rehearsal tag/)
  })

  it('LIVE needs the typed tag, and real data also needs the reconciled-rehearsal gate to say ok', () => {
    const live = { ...base, target: 'LIVE' as const }
    expect(applyBlockReason({ ...live, tag: '' })).toMatch(/live tag/)
    expect(applyBlockReason({ ...live, tag: 'GO-LIVE' })).toMatch(/reconciled rehearsal/)
    expect(applyBlockReason({ ...live, tag: 'GO-LIVE', rehearsalGate: { ok: false, reason: 'No RECONCILED rehearsal for this stage hash.' } }))
      .toBe('No RECONCILED rehearsal for this stage hash.')
    expect(applyBlockReason({ ...live, tag: 'GO-LIVE', rehearsalGate: { ok: true } })).toBeNull()
  })

  it('a synthetic LIVE run needs the tag but not a rehearsal', () => {
    expect(applyBlockReason({ ...base, target: 'LIVE', tag: 'ZZ-IMPORT-1k', synthetic: true })).toBeNull()
  })
})

describe('furthestStep / progress', () => {
  it('maps job status to the furthest step reachable', () => {
    expect(furthestStep(null)).toBe(0)
    expect(furthestStep(job({ status: 'READY' }))).toBe(3)
    expect(furthestStep(job({ status: 'PLANNED' }))).toBe(4)
    expect(furthestStep(job({ status: 'RUNNING' }))).toBe(4)
    expect(furthestStep(job({ status: 'APPLIED' }))).toBe(5)
  })

  it('computes percent, rows per second and ETA from the per-entity outcomes', () => {
    const j = job({
      status: 'RUNNING', phase: 'LOAD', startedAt: '2026-11-03T11:58:00Z',
      entityCounts: { LOAD: { staged: 1000, created: 300, matched: 0, enriched: 0, skipped: 0, conflicts: 0, errors: 0 } },
    })
    expect(progressOf(j, NOW)).toMatchObject({ percent: 30, done: 300, staged: 1000, rowsPerSecond: 2.5, etaSeconds: 280, phaseLabel: 'LOAD' })
  })
})

describe('money and masking helpers', () => {
  it.each([['9,106,729.69', 910672969], ['-13068.59', -1306859], ['$5', 500], ['1.5', 150], ['', null], ['1.234', null], ['abc', null]])(
    'centsFromTyped(%j) = %j', (text, cents) => expect(centsFromTyped(text)).toBe(cents),
  )

  it('renders cents fields as dollars and blanks as a dash, leaving server-masked text untouched', () => {
    expect(sampleCell('invoiceAmountCents', 1234567)).toBe('$12,345.67')
    expect(sampleCell('balDueCents', -500)).toBe('-$5.00')
    expect(sampleCell('customer', 'A••• F•••')).toBe('A••• F•••')
    expect(sampleCell('shipDate', null)).toBe('—')
  })
})
