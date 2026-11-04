import { describe, it, expect } from 'vitest'
import { PLACEHOLDER_EMAILS, TARGET_DIVISIONS, applyPlan, describePlan, planRevDivisions } from './seedRevDivisions.mjs'

const row = (code, over = {}) => ({
  id: code, code, name: code, brand: null, parentId: null, color: null, sortOrder: 10, active: true,
  owners: null, flows: null, intakeEmail: null, version: 1, ...over,
})

/** The production-copy shape from PHASE0 §5.6 before this script runs. */
const BEFORE = () => [
  row('BROKERAGE', { name: 'BCAT Logistics', intakeEmail: 'tenders@bcatcorp.com' }),
  row('ASSETS', { name: 'Ivan Cartage', owners: JSON.stringify({ building: 'Ivan' }), flows: JSON.stringify({ driverPay: true }) }),
  row('OWNER_OPERATOR', { name: 'Owner Operators', parentId: 'ASSETS', owners: JSON.stringify({ tracking: 'Dispatch' }) }),
  row('BOX_TRUCK', { name: 'Box trucks', parentId: 'ASSETS' }),
  row('LOCAL', { name: 'Local drivers', parentId: 'ASSETS' }),
  row('CAR_SHIPPING', { name: 'Best Care Auto Transport', brand: 'Best Care Auto Transport' }),
  row('COMPANY', { name: 'Company' }),
]

const stepFor = (plan, kind, code) => plan.steps.find((s) => s.kind === kind && s.code === code)

describe('planRevDivisions', () => {
  it('renames CAR_SHIPPING in place (same code, brand follows the old name) and never creates a second row', () => {
    const plan = planRevDivisions({ divisions: BEFORE() })
    const save = stepFor(plan, 'SAVE', 'CAR_SHIPPING')
    expect(save.input).toMatchObject({ id: 'CAR_SHIPPING', code: 'CAR_SHIPPING', name: 'Auto Shipping', brand: 'Auto Shipping' })
    expect(plan.steps.filter((s) => s.kind === 'SAVE' && s.code === 'CAR_SHIPPING')).toHaveLength(1)
  })

  it('fills only blank intake e-mails, as unconfirmed, and never overwrites an existing address', () => {
    const plan = planRevDivisions({ divisions: BEFORE() })
    const brokerage = stepFor(plan, 'SAVE', 'BROKERAGE')
    expect(brokerage).toBeUndefined() // name already right, address already set: nothing to write
    expect(stepFor(plan, 'SAVE', 'ASSETS').input).toMatchObject({
      intakeEmail: PLACEHOLDER_EMAILS.ASSETS, intakeEmailConfirmed: false,
    })
    for (const code of ['CAR_SHIPPING', 'OWNER_OPERATOR']) {
      expect(stepFor(plan, 'SAVE', code).input).toMatchObject({ intakeEmail: PLACEHOLDER_EMAILS[code], intakeEmailConfirmed: false })
    }
    const touched = plan.steps.filter((s) => s.kind === 'SAVE').map((s) => s.input)
    expect(touched.some((i) => i.intakeEmail === 'tenders@bcatcorp.com')).toBe(false)
  })

  it('makes OWNER_OPERATOR top-level and keeps what it inherited: parent slots fill gaps, its own values win', () => {
    const { input } = stepFor(planRevDivisions({ divisions: BEFORE() }), 'SAVE', 'OWNER_OPERATOR')
    expect(input.parentId).toBeNull()
    expect(input.owners).toEqual({ building: 'Ivan', tracking: 'Dispatch' })
    expect(input.flows).toEqual({ driverPay: true })
  })

  it('archives what is not in the target list, children before parents, and nothing else', () => {
    const plan = planRevDivisions({ divisions: BEFORE() })
    const archived = plan.steps.filter((s) => s.kind === 'ARCHIVE').map((s) => s.code).sort()
    expect(archived).toEqual(['BOX_TRUCK', 'COMPANY', 'LOCAL'])
    expect(plan.blocked).toEqual([])
    const final = plan.final.filter((d) => d.active).map((d) => d.code).sort()
    expect(final).toEqual(TARGET_DIVISIONS.map((t) => t.code).sort())
  })

  it('refuses to archive a division an active rule still names, and says which rule', () => {
    const plan = planRevDivisions({
      divisions: BEFORE(),
      rules: [{ id: 'rule-9', name: 'Box trucks', active: true, divisionCode: 'BOX_TRUCK' }, { id: 'rule-1', name: 'Old', active: false, divisionCode: 'LOCAL' }],
      shipmentCounts: new Map([['BOX_TRUCK', 12]]),
    })
    expect(stepFor(plan, 'ARCHIVE', 'BOX_TRUCK')).toBeUndefined()
    expect(plan.blocked).toEqual([
      { code: 'BOX_TRUCK', reason: expect.stringContaining('rule-9') },
    ])
    expect(plan.blocked[0].reason).toContain('12 shipment(s) tagged')
    expect(stepFor(plan, 'ARCHIVE', 'LOCAL')).toBeDefined() // an inactive rule is not a reference
  })

  it('is idempotent: planning from its own end state yields no steps', () => {
    const first = planRevDivisions({ divisions: BEFORE() })
    // Apply the saves to the rows the way the server would (JSON owners/flows stay objects).
    const after = first.final.map((d) => ({ ...d }))
    const second = planRevDivisions({ divisions: after })
    expect(second.steps).toEqual([])
    expect(second.blocked).toEqual([])
  })

  it('refuses a placeholder another active division already uses instead of creating a duplicate address', () => {
    const divisions = BEFORE()
    divisions.find((d) => d.code === 'BROKERAGE').intakeEmail = PLACEHOLDER_EMAILS.ASSETS
    const plan = planRevDivisions({ divisions })
    expect(plan.blocked.some((b) => b.code === 'ASSETS' && /already used by BROKERAGE/.test(b.reason))).toBe(true)
    expect(stepFor(plan, 'SAVE', 'ASSETS')).toBeUndefined()
  })

  it('creates a missing target division without an id (the server refuses an id for a new code)', () => {
    const plan = planRevDivisions({ divisions: BEFORE().filter((d) => d.code !== 'CAR_SHIPPING') })
    const create = stepFor(plan, 'SAVE', 'CAR_SHIPPING')
    expect(create.input).not.toHaveProperty('id')
    expect(create.input).toMatchObject({ code: 'CAR_SHIPPING', name: 'Auto Shipping', active: true })
  })
})

describe('applyPlan / describePlan', () => {
  it('performs the steps in plan order through save/archive only', async () => {
    const plan = planRevDivisions({ divisions: BEFORE() })
    const calls = []
    await applyPlan(plan, { save: async (i) => calls.push(`save ${i.code}`), archive: async (i) => calls.push(`archive ${i.id}`) })
    expect(calls).toEqual(plan.steps.map((s) => (s.kind === 'SAVE' ? `save ${s.code}` : `archive ${s.code}`)))
    // The re-parenting save lands before any archive, so no archive sees a still-active child.
    expect(calls.findIndex((c) => c === 'save OWNER_OPERATOR')).toBeLessThan(calls.findIndex((c) => c.startsWith('archive')))
  })

  it('prints the four UNCONFIRMED addresses even when there is nothing to do', () => {
    const text = describePlan({ steps: [], blocked: [], notes: [] }, { apply: false })
    expect(text).toContain('DRY RUN')
    for (const email of Object.values(PLACEHOLDER_EMAILS)) expect(text).toContain(email)
  })
})
