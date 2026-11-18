import { describe, it, expect } from 'vitest'
import { personalTemplateId } from '@/lib/personalColumnLayout'
import {
  allowedColumnKeys, holdsAnyAccountingPage, limitLayoutToAllowed, pickLayout, resolvePersonalLayout, teamDefaultIsNewer,
} from './personalLayout'

const KEYS = ['proNumber', 'status', 'customerName', 'originCity', 'grossProfit', 'customerTotalRate', 'apStatus']
const DEFAULTS = ['proNumber', 'status']
const row = (email: string, list: 'active' | 'all' | 'voided', columns: string[], over: Record<string, unknown> = {}) => ({
  id: personalTemplateId(list, email), columns, widths: {}, pinned: [], ownerEmail: email, updatedAt: '2026-11-10T00:00:00.000Z', ...over,
})

describe('resolvePersonalLayout', () => {
  it('is null with no row of the person\'s own, and ignores somebody else\'s row', () => {
    expect(resolvePersonalLayout('active', [], 'a@b.c', KEYS, DEFAULTS)).toBeNull()
    expect(resolvePersonalLayout('active', [row('x@b.c', 'active', ['proNumber'])], 'a@b.c', KEYS, DEFAULTS)).toBeNull()
  })

  it('refuses a row that carries the right id but another owner', () => {
    const forged = row('a@b.c', 'active', ['proNumber', 'originCity'], { ownerEmail: 'x@b.c' })
    expect(resolvePersonalLayout('active', [forged], 'a@b.c', KEYS, DEFAULTS)).toBeNull()
  })

  it('returns the saved columns, dropping retired keys and pins on hidden columns', () => {
    const saved = row('a@b.c', 'all', ['originCity', 'gone', 'proNumber'], { widths: { originCity: 200, gone: 99 }, pinned: ['originCity', 'status'] })
    expect(resolvePersonalLayout('all', [saved], 'a@b.c', KEYS, DEFAULTS)).toEqual({
      columns: ['originCity', 'proNumber'], widths: { originCity: 200 }, pinned: ['originCity'],
    })
  })

  it('is null when none of the saved columns exist any more', () => {
    expect(resolvePersonalLayout('all', [row('a@b.c', 'all', ['gone'])], 'a@b.c', KEYS, DEFAULTS)).toBeNull()
  })
})

describe('pickLayout', () => {
  const team = { columns: ['proNumber'], widths: {}, pinned: [] }
  const mine = { columns: ['originCity'], widths: {}, pinned: [] }
  it('prefers theirs unless they switched to the team layout; the team layout when they have none', () => {
    expect(pickLayout('mine', mine, team)).toEqual({ layout: mine, source: 'mine' })
    expect(pickLayout('team', mine, team)).toEqual({ layout: team, source: 'team' })
    expect(pickLayout('mine', null, team)).toEqual({ layout: team, source: 'team' })
  })
})

describe('money columns', () => {
  it('stay out of a layout for anybody without an accounting page, unless the team default already shows them', () => {
    expect(allowedColumnKeys(KEYS, true)).toEqual(KEYS)
    expect(allowedColumnKeys(KEYS, false)).toEqual(['proNumber', 'status', 'customerName', 'originCity'])
    expect(allowedColumnKeys(KEYS, false, ['apStatus'])).toContain('apStatus')
    expect(allowedColumnKeys(KEYS, false, ['apStatus'])).not.toContain('grossProfit')
  })

  it('limitLayoutToAllowed drops disallowed columns, with their widths and pins, but never empties the grid', () => {
    const layout = { columns: ['proNumber', 'grossProfit', 'originCity'], widths: { grossProfit: 120, originCity: 90 }, pinned: ['grossProfit', 'proNumber'] }
    expect(limitLayoutToAllowed(layout, ['proNumber', 'originCity'])).toEqual({ columns: ['proNumber', 'originCity'], widths: { originCity: 90 }, pinned: ['proNumber'] })
    expect(limitLayoutToAllowed(layout, ['status'])).toBe(layout)
  })

  it('holdsAnyAccountingPage: owner and admins yes, a plain team member no, one page grant yes', () => {
    expect(holdsAnyAccountingPage(['ADMIN'], 'x@bcatcorp.com')).toBe(true)
    expect(holdsAnyAccountingPage([], 'ryne@bcatcorp.com')).toBe(true)
    expect(holdsAnyAccountingPage(['page-tms'], 'jason@bcatcorp.com')).toBe(false)
    expect(holdsAnyAccountingPage(['page-invoicing'], 'dennis@bcatcorp.com')).toBe(true)
  })
})

describe('teamDefaultIsNewer', () => {
  const team = (updatedAt: string) => ({ id: 'shipments-team-default-active', columns: ['proNumber'], widths: {}, pinned: [], updatedAt })
  it('is true only when the team saved after the person did, and the person has not seen that save', () => {
    const mine = row('a@b.c', 'active', ['proNumber'], { updatedAt: '2026-11-10T00:00:00.000Z' })
    expect(teamDefaultIsNewer('active', [team('2026-11-18T00:00:00.000Z'), mine], 'a@b.c', null)).toBe(true)
    expect(teamDefaultIsNewer('active', [team('2026-11-18T00:00:00.000Z'), mine], 'a@b.c', '2026-11-18T00:00:00.000Z')).toBe(false)
    expect(teamDefaultIsNewer('active', [team('2026-11-01T00:00:00.000Z'), mine], 'a@b.c', null)).toBe(false)
    expect(teamDefaultIsNewer('active', [team('2026-11-18T00:00:00.000Z')], 'a@b.c', null)).toBe(false)
  })
})
