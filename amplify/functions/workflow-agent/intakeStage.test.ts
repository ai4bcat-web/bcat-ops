/**
 * Staging unit tests: routing by recipient address, one row per e-mail, and "never throws".
 * The whole-pipeline behaviour (tender → run + intake writes, gated/failed/blacklisted runs) is
 * defended in run.test.ts against the in-memory DynamoDB engine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const db = vi.hoisted(() => ({
  divisions: [] as Row[],
  intake: new Map<string, Row>(),
  failPut: false,
  existing: null as Row | null,
  logged: [] as Row[],
}))

vi.mock('./store', () => ({
  CUSTOMER_TABLE_NAME: 'Customer-test',
  nowIso: () => '2026-11-03T10:00:00.000Z',
  getById: async () => null,
  getSettings: async () => null,
  listDivisions: async () => db.divisions,
  findIntakeByReference: async () => db.existing,
  logRepeatEmail: async (row: Row, entry: Row) => { db.logged.push({ row, entry }) },
  putIntakeLoadIfAbsent: async (row: Row) => {
    if (db.failPut) throw new Error('DynamoDB unavailable')
    if (db.intake.has(String(row.id))) return false
    db.intake.set(String(row.id), row)
    return true
  },
}))

import { cleanToAddresses, stageIntake, type IntakeSourceMail, type StageInput } from './intakeStage'
import type { RunRow } from './store'

const run = (agent = 'TENDER') => ({ id: 'wf:TENDER:abc', agent, sourceKey: 'workflow-inbox/abc/message.json' }) as unknown as RunRow
const mail = (toAddresses: string[]): IntakeSourceMail => ({
  subject: 'Tender', fromEmail: 'dispatch@batory.com', fromName: 'Dispatch', receivedAt: '2026-11-03T09:00:00.000Z',
  bodyText: 'Ref #: 1', attachments: [], toAddresses,
})
const BARE: StageInput = { kind: 'BARE', parseState: 'NOT_PARSED', parseNote: 'DAILY_CAP' }

beforeEach(() => {
  db.intake.clear()
  db.failPut = false
  db.existing = null
  db.logged = []
  db.divisions = [
    { id: 'A', code: 'A', name: 'A', active: true, intakeEmail: 'tenders+a@bcatcorp.com' },
    { id: 'B', code: 'B', name: 'B', active: true, intakeEmail: 'tenders+b@bcatcorp.com' },
    { id: 'OLD', code: 'OLD', name: 'Old', active: false, intakeEmail: 'old@bcatcorp.com' },
  ]
})

describe('stageIntake', () => {
  it('routes to the division of the first reported address that matches one', async () => {
    await stageIntake(run(), mail(['someone@else.com', 'tenders+b@bcatcorp.com', 'tenders+a@bcatcorp.com']), BARE)
    expect(db.intake.get('il:wf:TENDER:abc')).toMatchObject({ divisionCode: 'B', toAddress: 'tenders+b@bcatcorp.com' })
  })

  it('an address nobody owns, or an archived division\'s, is Unrouted', async () => {
    await stageIntake(run(), mail(['old@bcatcorp.com', 'nobody@bcatcorp.com']), BARE)
    expect(db.intake.get('il:wf:TENDER:abc')).toMatchObject({ divisionCode: null, toAddress: null })
  })

  it('DEMO: a division owning the demo Gmail mailbox receives mail sent to it; mail to an unrelated address stays Unrouted', async () => {
    db.divisions = [{ id: 'D', code: 'D', name: 'Demo', active: true, intakeEmail: 'ai4bcat@gmail.com' }]
    await stageIntake(run(), mail(['AI4BCAT@gmail.com']), BARE)
    expect(db.intake.get('il:wf:TENDER:abc')).toMatchObject({ divisionCode: 'D', toAddress: 'ai4bcat@gmail.com' })
    db.intake.clear()
    await stageIntake(run(), mail(['stranger@gmail.com']), BARE)
    expect(db.intake.get('il:wf:TENDER:abc')).toMatchObject({ divisionCode: null })
  })

  it('is one row per e-mail: a second stage is a no-op and never overwrites an edited row', async () => {
    await stageIntake(run(), mail(['tenders+a@bcatcorp.com']), BARE)
    db.intake.set('il:wf:TENDER:abc', { ...(db.intake.get('il:wf:TENDER:abc') as Row), commodity: 'edited', version: 4 })
    const again = await stageIntake(run(), mail(['tenders+b@bcatcorp.com']), BARE)
    expect(again.staged).toBe(false)
    expect(db.intake.size).toBe(1)
    expect(db.intake.get('il:wf:TENDER:abc')).toMatchObject({ commodity: 'edited', version: 4, divisionCode: 'A' })
  })

  it('a repeat e-mail for the same tender rolls into the existing row (reopening a dismissed one) and stages no second row', async () => {
    const parsed = {
      kind: 'PARSED', party: { kind: null, id: null, name: null, how: null }, candidates: [], stopFacilityHits: [],
      parse: { tender: { reference: '214129178', stops: [] }, parserTender: { reference: '214129178', stops: [] }, fillKind: 'EMAIL', lowConfidence: [] },
    } as unknown as StageInput
    db.existing = { id: 'il:wf:TENDER:first', status: 'DISMISSED' }
    const out = await stageIntake(run(), mail(['tenders+a@bcatcorp.com']), parsed)
    expect(out).toMatchObject({ staged: false })
    expect(out.detail).toContain('rolled into intake load il:wf:TENDER:first (reopened)')
    expect(db.logged).toHaveLength(1)
    expect(db.intake.size).toBe(0)
  })

  it('a bare row keeps the e-mail and says why nothing was parsed', async () => {
    await stageIntake(run(), mail([]), BARE)
    expect(db.intake.get('il:wf:TENDER:abc')).toMatchObject({
      status: 'OPEN', parseState: 'NOT_PARSED', parseNote: 'DAILY_CAP', subject: 'Tender', bodyText: 'Ref #: 1', version: 1,
    })
  })

  it('stages nothing for a run that is not a tender', async () => {
    const result = await stageIntake(run('QUOTE'), mail(['tenders+a@bcatcorp.com']), BARE)
    expect(result.staged).toBe(false)
    expect(db.intake.size).toBe(0)
  })

  it('swallows a failing write and reports it in the detail', async () => {
    db.failPut = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await stageIntake(run(), mail([]), BARE)
    expect(error).toHaveBeenCalledWith('[workflow-agent] intake staging failed', expect.any(String), expect.any(Error))
    error.mockRestore()
    expect(result).toMatchObject({ staged: false })
    expect(result.detail).toMatch(/intake staging failed.*DynamoDB unavailable/)
  })
})

describe('cleanToAddresses', () => {
  it('lower-cases, trims, de-duplicates, drops non-strings and over-long entries, caps at 20', () => {
    const out = cleanToAddresses([' A@X.com', 'a@x.com', 7, null, 'b@x.com', 'y'.repeat(321), ...Array.from({ length: 30 }, (_, i) => `u${i}@x.com`)])
    expect(out).toHaveLength(20)
    expect(out.slice(0, 2)).toEqual(['a@x.com', 'b@x.com'])
    expect(cleanToAddresses('nope')).toEqual([])
  })
})
