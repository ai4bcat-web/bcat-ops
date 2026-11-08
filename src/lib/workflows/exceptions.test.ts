/**
 * The status trap is the case worth pinning hardest: the backfill sets a shipment's
 * status from its stop clock, so an unresolved shipment can arrive already DELIVERED.
 * A rule written as "DRAFT means unresolved" waves it straight through to AR.
 *
 * Everything else here is about not crying wolf — a dev-neutered integration, a link
 * that pinged recently and a cancelled shipment are all fine.
 */
import { describe, it, expect } from 'vitest'
import {
  EXCEPTION_TABS,
  actionsFor,
  collectExceptions,
  countsByIntegration,
  defaultAgentsFor,
  defaultFilterFor,
  type ExceptionInput,
} from './exceptions'
import type { WorkflowRunRecord } from '../../types/tms'

const NOW = '2026-10-29T18:00:00.000Z'

function input(over: Partial<ExceptionInput> = {}): ExceptionInput {
  return {
    runs: [],
    shipments: [],
    loads: [],
    trackingLinks: [],
    integrations: [],
    settings: { trackingIntervalMin: 30 },
    nowIso: NOW,
    ...over,
  }
}

function run(over: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 'wf:TENDER:abc',
    agent: 'TENDER',
    status: 'COMPLETED',
    outcome: 'UNKNOWN_PARTY',
    exceptionOpen: 'OPEN',
    sourceId: 'intake-1',
    fromEmail: 'stranger@unknown.com',
    createdBy: 'workflow-agent',
    updatedBy: 'workflow-agent',
    updatedAt: '2026-10-29T17:00:00.000Z',
    ...over,
  }
}

describe('collectExceptions — unknown customer', () => {
  it('catches an unresolved shipment that already delivered', () => {
    const rows = collectExceptions(
      input({ shipments: [{ id: 'shp-1', number: 'S000123', status: 'DELIVERED', customerId: null }] }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('UNKNOWN_CUSTOMER')
    expect(rows[0].shipmentNumber).toBe('S000123')
    expect(rows[0].actions.map((a) => a.key)).toEqual(['IDENTIFY_CUSTOMER'])
  })

  it('leaves a voided or cancelled shipment alone', () => {
    const rows = collectExceptions(
      input({
        shipments: [
          { id: 'shp-void', status: 'DELIVERED', customerId: null, voidedAt: NOW },
          { id: 'shp-cancel', status: 'CANCELED', customerId: null },
          { id: 'shp-ok', status: 'DELIVERED', customerId: 'cus-1' },
        ],
      }),
    )
    expect(rows).toEqual([])
  })
})

describe('collectExceptions — tracking', () => {
  it('raises an overdue check call', () => {
    const rows = collectExceptions(
      input({
        loads: [
          {
            id: 'load-1',
            shipmentId: 'shp-1',
            status: 'IN_TRANSIT',
            checkCallOpen: 'OPEN',
            nextCheckCallAt: '2026-10-29T16:00:00.000Z',
          },
        ],
      }),
    )
    expect(rows.map((r) => r.kind)).toEqual(['TRACKING'])
    expect(rows[0].actions.map((a) => a.key)).toEqual(['RESEND_LINK', 'TEXT_DRIVER', 'LOG_CHECK_CALL'])
  })

  it('leaves a check call that is not due yet', () => {
    const rows = collectExceptions(
      input({
        loads: [
          { id: 'load-1', status: 'IN_TRANSIT', checkCallOpen: 'OPEN', nextCheckCallAt: '2026-10-29T19:00:00.000Z' },
        ],
      }),
    )
    expect(rows).toEqual([])
  })

  it('raises a silent ping link but not one inside three intervals', () => {
    const loads = [{ id: 'load-1', shipmentId: 'shp-1', status: 'IN_TRANSIT' }]
    const link = { id: 'tl-1', kind: 'CARRIER_PING', status: 'ACTIVE', shipmentId: 'shp-1', loadId: 'load-1' }

    // 30 minute interval: 80 minutes is still inside the 90 minute allowance.
    const fresh = collectExceptions(
      input({ loads, trackingLinks: [{ ...link, lastPingAt: '2026-10-29T16:40:00.000Z' }] }),
    )
    expect(fresh).toEqual([])

    const stale = collectExceptions(
      input({ loads, trackingLinks: [{ ...link, lastPingAt: '2026-10-29T16:00:00.000Z' }] }),
    )
    expect(stale.map((r) => r.kind)).toEqual(['TRACKING'])
  })

  it('ignores a ping link whose load has stopped moving', () => {
    const rows = collectExceptions(
      input({
        loads: [{ id: 'load-1', status: 'DELIVERED' }],
        trackingLinks: [
          {
            id: 'tl-1',
            kind: 'CARRIER_PING',
            status: 'ACTIVE',
            loadId: 'load-1',
            lastPingAt: '2026-10-28T00:00:00.000Z',
          },
        ],
      }),
    )
    expect(rows).toEqual([])
  })

  it('grades a link whose load row is not in the list on the status the link carries', () => {
    // The Errors tab only lists the loads with an open check call, so the silent trucks
    // nobody set a reminder on arrive with no load row at all. Dropping them would make
    // the rule invisible on exactly the loads it exists to catch.
    const link = {
      id: 'tl-2',
      kind: 'CARRIER_PING',
      status: 'ACTIVE',
      shipmentId: 'shp-2',
      loadId: 'load-2',
      shipmentNumber: 'S000222',
      lastPingAt: '2026-10-29T15:00:00.000Z',
    }

    const moving = collectExceptions(input({ trackingLinks: [{ ...link, movementStatus: 'IN_TRANSIT' }] }))
    expect(moving.map((r) => r.kind)).toEqual(['TRACKING'])
    expect(moving[0].shipmentNumber).toBe('S000222')

    const delivered = collectExceptions(input({ trackingLinks: [{ ...link, movementStatus: 'DELIVERED' }] }))
    expect(delivered).toEqual([])

    const unknown = collectExceptions(input({ trackingLinks: [link] }))
    expect(unknown).toEqual([])
  })
})

describe('collectExceptions — integrations', () => {
  it('never raises a provider that is only neutered on dev', () => {
    const rows = collectExceptions(
      input({
        integrations: [
          {
            id: 'int-dat',
            provider: 'DAT',
            kind: 'PROVIDER',
            health: 'UNABLE_TO_VERIFY',
            healthReason: 'NEUTERED_ON_DEV',
          },
          { id: 'int-x', provider: 'HIGHWAY', kind: 'PROVIDER', health: 'OK', healthReason: 'OK' },
          { id: 'int-w', provider: 'DAT', kind: 'WEBHOOK_EVENT', health: 'INVALID_CREDENTIALS' },
        ],
      }),
    )
    expect(rows).toEqual([])
  })

  it('sorts a broken provider into its own tab', () => {
    const rows = collectExceptions(
      input({
        integrations: [
          { id: 'i1', provider: 'QUICKBOOKS_ONLINE', kind: 'PROVIDER', health: 'INVALID_CREDENTIALS' },
          { id: 'i2', provider: 'PARADE', kind: 'PROVIDER', health: 'INVALID_CREDENTIALS' },
          { id: 'i3', provider: 'ORDERFUL', kind: 'PROVIDER', health: 'UNABLE_TO_VERIFY' },
          { id: 'i4', provider: 'DAT', kind: 'PROVIDER', health: 'INVALID_CREDENTIALS' },
        ],
      }),
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('integration:i1')?.kind).toBe('ACCOUNTING')
    expect(byId.get('integration:i2')?.kind).toBe('PARADE')
    expect(byId.get('integration:i3')?.kind).toBe('EDI')
    expect(byId.get('integration:i4')?.kind).toBe('INTEGRATION')

    // QuickBooks is preview-only, so its re-check is offered and refused with a reason.
    expect(byId.get('integration:i1')?.actions[0].disabledReason).toMatch(/preview-only/)
    expect(byId.get('integration:i3')?.actions).toEqual([])
  })
})

describe('collectExceptions — AI runs', () => {
  it('offers retry only while the run can still be retried', () => {
    const rows = collectExceptions(
      input({ runs: [run({ attempts: 1 }), run({ id: 'wf:AP:z', agent: 'AP', attempts: 5, status: 'FAILED' })] }),
    )
    const retry = rows.map((r) => r.actions.find((a) => a.key === 'RETRY'))
    expect(retry.every(Boolean)).toBe(true)
    expect(rows.find((r) => r.runId === 'wf:TENDER:abc')?.actions[0].disabledReason).toBeUndefined()
    expect(rows.find((r) => r.runId === 'wf:AP:z')?.actions[0].disabledReason).toMatch(/5 times/)
  })

  it('skips a run whose exception is already resolved', () => {
    expect(collectExceptions(input({ runs: [run({ exceptionOpen: null })] }))).toEqual([])
  })
})

describe('countsByIntegration', () => {
  it('counts every row exactly once', () => {
    const rows = collectExceptions(
      input({
        runs: [run()],
        shipments: [{ id: 'shp-1', status: 'DELIVERED', customerId: null }],
        integrations: [{ id: 'i1', provider: 'PARADE', kind: 'PROVIDER', health: 'INVALID_CREDENTIALS' }],
      }),
    )
    const counts = countsByIntegration(rows)
    expect(counts.ALL).toBe(rows.length)
    const kinds = EXCEPTION_TABS.filter((t) => t.key !== 'ALL').map((t) => t.key)
    const summed = kinds.reduce((total, key) => total + counts[key], 0)
    expect(summed).toBe(counts.ALL)
  })
})

describe('defaultFilterFor', () => {
  it('matches the spec matrix for each role', () => {
    const all = EXCEPTION_TABS.filter((t) => t.key !== 'ALL').map((t) => t.key)
    expect([...defaultFilterFor(['role-ADMIN'])].sort()).toEqual([...all].sort())
    expect([...defaultFilterFor(['role-MANAGER'])].sort()).toEqual([...all].sort())
    expect([...defaultFilterFor(['role-COMPLIANCE'])].sort()).toEqual([...all].sort())
    expect(defaultFilterFor(['role-AR_AP'])).toEqual(['ACCOUNTING', 'AI'])
    expect(defaultFilterFor(['role-CUSTOMER_REP'])).toEqual(['AI', 'UNKNOWN_CUSTOMER', 'EDI'])
    expect(defaultFilterFor(['role-CARRIER_REP'])).toEqual(['AI', 'TRACKING', 'PARADE'])
    expect([...defaultFilterFor(['page-tms'])].sort()).toEqual([...all].sort())
  })
})

describe('defaultAgentsFor', () => {
  it('opens each role on the agents the spec matrix gives it, and nobody else', () => {
    // The three all-seeing roles and the owner read every agent's rows.
    for (const groups of [['owner'], ['role-ADMIN'], ['role-MANAGER'], ['role-COMPLIANCE']]) {
      expect([...defaultAgentsFor(groups)].sort()).toEqual(['AP', 'CAPACITY', 'QUOTE', 'TENDER', 'WEBHOOK'])
    }

    // A4: accounting reads AP, a customer rep reads the two customer agents, a carrier
    // rep reads the two carrier ones.
    expect(defaultAgentsFor(['role-AR_AP'])).toEqual(['AP'])
    expect([...defaultAgentsFor(['role-CUSTOMER_REP'])].sort()).toEqual(['QUOTE', 'TENDER'])
    expect([...defaultAgentsFor(['role-CARRIER_REP'])].sort()).toEqual(['AP', 'CAPACITY'])

    // Two roles on one person is the union, not the intersection.
    expect([...defaultAgentsFor(['role-AR_AP', 'role-CUSTOMER_REP'])].sort()).toEqual(['AP', 'QUOTE', 'TENDER'])

    // A default, never a refusal: a caller nobody mapped sees everything.
    expect([...defaultAgentsFor(['page-tms'])].sort()).toEqual(['AP', 'CAPACITY', 'QUOTE', 'TENDER', 'WEBHOOK'])
    expect([...defaultAgentsFor(['role-DISPATCH'])].sort()).toEqual(['AP', 'CAPACITY', 'QUOTE', 'TENDER', 'WEBHOOK'])
  })

  it('gives an AI row the agent the filter grades it on', () => {
    const rows = collectExceptions(input({ runs: [run({ id: 'wf:AP:1', agent: 'AP' })] }))
    expect(rows.map((r) => r.agent)).toEqual(['AP'])
  })
})

describe('actionsFor', () => {
  it('falls back to the kind’s own actions for a row assembled elsewhere', () => {
    expect(
      actionsFor({ id: 'x', at: NOW, kind: 'UNKNOWN_CUSTOMER', party: '—', integration: '—', error: '—', actions: [] })
        .map((a) => a.key),
    ).toEqual(['IDENTIFY_CUSTOMER'])
  })
})
