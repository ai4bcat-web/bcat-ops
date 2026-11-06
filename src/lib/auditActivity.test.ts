import { describe, expect, it } from 'vitest'
import { actionSentence, auditDetail, buildActivityRows, relativeTime, type AuditRowLike } from './auditActivity'

const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it('steps through just now, minutes, hours, days, then the date', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now')
    expect(relativeTime(ago(5 * MIN), NOW)).toBe('5m ago')
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe('3h ago')
    expect(relativeTime(ago(2 * DAY), NOW)).toBe('2d ago')
    expect(relativeTime(ago(45 * DAY), NOW)).toBe('2026-09-21')
  })
  it('never prints a negative age for a clock-skewed row and ignores garbage', () => {
    expect(relativeTime(ago(-5 * MIN), NOW)).toBe('just now')
    expect(relativeTime('not a date', NOW)).toBe('')
  })
})

describe('actionSentence', () => {
  it('speaks the real Lambda actions in plain words', () => {
    expect(actionSentence('CREATE_SHIPMENT')).toBe('created the shipment')
    expect(actionSentence('ASSIGN_CARRIER')).toBe('covered the load with a carrier')
    expect(actionSentence('COMMIT_DOCUMENT')).toBe('uploaded a document')
    expect(actionSentence('INTAKE_EXTRACTED')).toBe('extracted the fields from the e-mail')
    expect(actionSentence('update', 'Load')).toBe('updated the load')
  })
  it('humanises an action it does not know, and does not trip on inherited keys', () => {
    expect(actionSentence('REASSIGN_SHIPMENTS_BY_REP_CODE')).toBe('reassign shipments by rep code')
    expect(actionSentence('setCustomerRate')).toBe('set customer rate')
    expect(actionSentence('constructor')).toBe('constructor')
  })
})

describe('auditDetail', () => {
  it('shows the first changed field with its new value; the old value goes in the hover', () => {
    expect(auditDetail({ customerRateCents: { from: 200000, to: 240000 }, weight: { from: 1, to: 2 } }))
      .toEqual({ text: 'customer rate: $2,400.00', title: 'was $2,000.00' })
    expect(auditDetail({ status: 'COVERED' })).toEqual({ text: 'status: COVERED', title: '' })
    expect(auditDetail({ holdReason: { from: null, to: 'x' }, equipmentType: { from: null, to: 'Reefer' } })?.text).toBe('equipment type: Reefer')
  })
  it('masks PII values but keeps the field name, and never prints bodies, secrets or tokens', () => {
    expect(auditDetail({ driverPhone: { from: '3125550101', to: '3125550199' } })).toEqual({ text: 'driver phone: ••••', title: 'was ••••' })
    expect(auditDetail({ message: 'hello driver', token: 'abc', status: 'DISPATCHED' })?.text).toBe('status: DISPATCHED')
    expect(auditDetail({ body: 'secret text', apiKey: 'k' })).toBeNull()
  })
  it('has nothing to say for empty or nested-only changes', () => {
    expect(auditDetail({})).toBeNull()
    expect(auditDetail(null)).toBeNull()
    expect(auditDetail({ stops: { a: { b: 1 } } })).toBeNull()
  })
})

const row = (n: number, over: Partial<AuditRowLike> = {}): AuditRowLike => ({
  id: `a${n}`, entityType: 'SHIPMENT', action: 'SAVE_ORDER_FORM', user: 'dee@bcatcorp.com', changes: { status: 'OPEN' }, createdAt: ago(n * MIN), ...over,
})

describe('buildActivityRows', () => {
  const staff = [{ id: 'u1', email: 'dee@bcatcorp.com', name: 'Dee Dispatch' }]

  it('returns the newest eight, newest first', () => {
    const rows = buildActivityRows([...Array.from({ length: 12 }, (_, i) => row(i + 1))].reverse(), staff, NOW)
    expect(rows).toHaveLength(8)
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])
    expect(rows[0]).toMatchObject({ time: '1m ago', action: 'saved the shipment form', detail: 'status: OPEN' })
    expect(rows[0]!.actor.label).toBe('Dee Dispatch')
  })

  it('shows one row when the same action is written to the shipment and the intake item in one instant', () => {
    const at = ago(MIN)
    const rows = buildActivityRows([row(1, { id: 's', createdAt: at, entityType: 'SHIPMENT' }), row(1, { id: 'i', createdAt: at, entityType: 'INTAKE_LOAD' })], staff, NOW)
    expect(rows).toHaveLength(1)
  })

  it('labels an automation row as an AI agent', () => {
    const [r] = buildActivityRows([row(1, { user: 'workflow-agent', action: 'SWEEP_STALLED', changes: { errorCode: 'STALLED' } })], staff, NOW)
    expect(r!.actor.label).toBe('AI agent · Workflow agent')
    expect(r!.action).toBe('sweep stalled')
  })
})

describe('auditDetail with AppSync AWSJSON strings', () => {
  it('unwraps a changes value that arrives as a JSON string', () => {
    expect(auditDetail('{"stops":3,"revenueCents":240000}')).toEqual({ text: 'stops: 3', title: '' })
    expect(auditDetail('not json')).toBeNull()
  })
})
