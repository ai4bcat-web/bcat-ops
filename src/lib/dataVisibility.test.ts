import { describe, expect, it } from 'vitest'
import { canSeeAccount } from './crm/visibility'
import {
  canSeeAR,
  canSeeCustomer,
  canSeeRow,
  dataViewer,
  hasViewAll,
  type VisCustomer,
} from './dataVisibility'
import { viewerFromGroups } from './crm/visibility'
import type { Team } from '../types/tms'

const REP = 'rep.a@bcat.test'
const teams: Team[] = [
  { key: 'east', name: 'East', memberIds: ['Rep.B@bcat.test ', 'someone-else'], active: true },
  { key: 'DEAD', name: 'Dead', memberIds: [REP, 'rep.b@bcat.test'], active: false },
]

const customers: VisCustomer[] = [
  { id: 'c-owned', accountOwnerIds: ['x', REP] },
  { id: 'c-default', defaultSalesRepId: REP },
  { id: 'c-team', teamKey: 'East', accountOwnerIds: ['other'] },
  { id: 'c-dead-team', teamKey: 'dead' },
  { id: 'c-nobody' },
  { id: 'c-other', accountOwnerIds: ['other'] },
]
const byId = new Map(customers.map((c) => [c.id, c]))
const seen = (v: ReturnType<typeof dataViewer>, row: Parameters<typeof canSeeRow>[1]) => canSeeRow(v, row, byId)

describe('data visibility', () => {
  const rep = dataViewer({ id: REP, email: REP, groups: ['page-tms'], teams })
  const repB = dataViewer({ id: 'rep.b@bcat.test', email: 'rep.b@bcat.test', groups: ['page-tms'], teams })
  const nobody = dataViewer({ id: 'zed@bcat.test', email: 'zed@bcat.test', groups: ['page-tms'], teams })

  it('rep sees customers they own through any owner slot or the default rep', () => {
    expect(seen(rep, { customerId: 'c-owned' })).toBe(true) // not the primary owner
    expect(seen(rep, { customerId: 'c-default' })).toBe(true)
    expect(seen(rep, { customerId: 'c-other' })).toBe(false)
  })

  it('a rep with no link sees nothing, and unowned customers are invisible', () => {
    for (const c of customers) expect(seen(nobody, { customerId: c.id })).toBe(false)
    expect(seen(rep, { customerId: 'c-nobody' })).toBe(false)
    // CRM would show the unowned account; the dashboard rule must not.
    expect(canSeeAccount(viewerFromGroups({ id: REP }), byId.get('c-nobody'))).toBe(true)
    expect(canSeeCustomer(rep, byId.get('c-nobody'))).toBe(false)
  })

  it('team members see the team customers, case-insensitively, others do not', () => {
    expect(repB.teamKeys.has('EAST')).toBe(true)
    expect(seen(repB, { customerId: 'c-team' })).toBe(true)
    expect(seen(rep, { customerId: 'c-team' })).toBe(false)
  })

  it('an inactive team grants nothing and a removed member loses access', () => {
    expect(seen(rep, { customerId: 'c-dead-team' })).toBe(false)
    const removed = dataViewer({
      id: 'rep.b@bcat.test',
      groups: [],
      teams: [{ ...teams[0], memberIds: ['someone-else'] }],
    })
    expect(seen(removed, { customerId: 'c-team' })).toBe(false)
  })

  it('a row naming the viewer is visible by id or e-mail, ignoring case and spaces', () => {
    expect(seen(rep, { customerId: 'c-other', salesRepId: '  REP.A@BCAT.TEST ' })).toBe(true)
    expect(seen(rep, { customerId: null, customerRepId: REP })).toBe(true)
    const byIdOnly = dataViewer({ id: 'sub-123', email: REP, groups: [] })
    expect(seen(byIdOnly, { salesRepId: 'sub-123' })).toBe(true)
    expect(seen(byIdOnly, { salesRepId: REP })).toBe(true)
  })

  it('a row with an unresolved customer is visible only through a direct rep field', () => {
    expect(seen(rep, { customerId: 'missing' })).toBe(false)
    expect(seen(rep, { customerId: 'missing', salesRepId: REP })).toBe(true)
    expect(seen(rep, {})).toBe(false)
  })

  it('carrier-side reps grant nothing', () => {
    expect(seen(rep, { customerId: 'c-other', carrierRepId: REP } as never)).toBe(false)
  })

  it('viewAll comes from owner, ADMIN, role AR_AP or claim VIEW_ALL; MANAGER alone is not enough', () => {
    const mk = (email: string, groups: string[]) => dataViewer({ id: email, email, groups, teams: [] })
    expect(mk('ryne@bcatcorp.com', []).viewAll).toBe(true)
    expect(mk('a@x.test', ['ADMIN']).viewAll).toBe(true)
    expect(mk('a@x.test', ['role-AR_AP']).viewAll).toBe(true)
    expect(mk('a@x.test', ['claim-VIEW_ALL']).viewAll).toBe(true)
    const manager = mk('m@x.test', ['role-MANAGER', 'page-tms'])
    expect(manager.viewAll).toBe(false)
    expect(hasViewAll(manager, ['role-MANAGER'])).toBe(false)
    expect(seen(mk('a@x.test', ['claim-VIEW_ALL']), { customerId: 'c-nobody' })).toBe(true)
    expect(seen(mk('a@x.test', ['claim-VIEW_ALL']), {})).toBe(true)
  })

  it('AR is judged through the invoice customer and its shipment rep', () => {
    expect(canSeeAR(rep, { customerId: 'c-owned' }, null, byId)).toBe(true)
    expect(canSeeAR(rep, { customerId: 'c-other' }, null, byId)).toBe(false)
    expect(canSeeAR(rep, { customerId: 'c-other' }, { salesRepId: REP }, byId)).toBe(true)
    expect(canSeeAR(rep, {}, { customerId: 'c-default' }, byId)).toBe(true)
  })
})
