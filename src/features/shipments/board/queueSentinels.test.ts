import { describe, it, expect } from 'vitest'

import { resolveQueueSentinels } from './useBoardFilters'
import { ME_SENTINEL, MY_TEAM_SENTINEL, SEED_VIEWS } from '@/lib/shipmentViewDefs'
import { EMPTY_BOARD_FILTER_SET, matchesBoardFilters, type ShipmentRow } from '../shipmentViews'

const viewer = { userId: 'rep.alvarez', teamRepIds: ['rep.alvarez', 'rep.bowen'] }

function row(dispatcherAssignedId: string | null): ShipmentRow {
  return {
    id: `s-${dispatcherAssignedId ?? 'none'}`,
    number: 'S000001',
    status: 'OPEN',
    dispatcherAssignedId,
  } as unknown as ShipmentRow
}

describe('queue view sentinels', () => {
  it('seeds My queue and Team queue as filter sets on the dispatcher facet', () => {
    const mine = SEED_VIEWS.find((v) => v.slug === 'my-queue')
    const team = SEED_VIEWS.find((v) => v.slug === 'team-queue')
    expect(mine?.filters.board?.details?.dispatcherAssigned?.values).toEqual([ME_SENTINEL])
    expect(team?.filters.board?.details?.dispatcherAssigned?.values).toEqual([MY_TEAM_SENTINEL])
  })

  it('resolves @me to the signed-in user', () => {
    const resolved = resolveQueueSentinels(
      { ...EMPTY_BOARD_FILTER_SET, details: { dispatcherAssigned: { values: [ME_SENTINEL], exclude: false } } },
      viewer,
    )
    expect(resolved.details?.dispatcherAssigned?.values).toEqual(['rep.alvarez'])
  })

  it('resolves @myteam to every rep on the team', () => {
    const resolved = resolveQueueSentinels(
      { ...EMPTY_BOARD_FILTER_SET, details: { dispatcherAssigned: { values: [MY_TEAM_SENTINEL], exclude: false } } },
      viewer,
    )
    expect(resolved.details?.dispatcherAssigned?.values).toEqual(['rep.alvarez', 'rep.bowen'])
  })

  it('matches nothing rather than everything when the viewer is on no team', () => {
    const filters = { ...EMPTY_BOARD_FILTER_SET, details: { dispatcherAssigned: { values: [MY_TEAM_SENTINEL], exclude: false } } }
    const resolved = resolveQueueSentinels(filters, { userId: 'rep.alvarez', teamRepIds: [] })
    const now = new Date()
    expect(matchesBoardFilters(row('rep.alvarez'), resolved, now)).toBe(false)
    expect(matchesBoardFilters(row(null), resolved, now)).toBe(false)
  })

  it('leaves a filter set without a sentinel untouched, by identity', () => {
    const filters = { ...EMPTY_BOARD_FILTER_SET, details: { dispatcherAssigned: { values: ['rep.bowen'], exclude: false } } }
    expect(resolveQueueSentinels(filters, viewer)).toBe(filters)
  })

  it('keeps a hand-picked value beside a resolved sentinel and de-duplicates', () => {
    const resolved = resolveQueueSentinels(
      { ...EMPTY_BOARD_FILTER_SET, details: { dispatcherAssigned: { values: [ME_SENTINEL, 'rep.alvarez', 'rep.chen'], exclude: false } } },
      viewer,
    )
    expect(resolved.details?.dispatcherAssigned?.values).toEqual(['rep.alvarez', 'rep.chen'])
  })

  it('narrows the board to the viewer, not to everybody assigned', () => {
    const resolved = resolveQueueSentinels(
      { ...EMPTY_BOARD_FILTER_SET, details: { dispatcherAssigned: { values: [ME_SENTINEL], exclude: false } } },
      viewer,
    )
    const now = new Date()
    expect(matchesBoardFilters(row('rep.alvarez'), resolved, now)).toBe(true)
    expect(matchesBoardFilters(row('rep.bowen'), resolved, now)).toBe(false)
  })
})
