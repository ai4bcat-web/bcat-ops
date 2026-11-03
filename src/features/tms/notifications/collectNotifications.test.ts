import { describe, expect, it } from 'vitest'
import {
  collectNotifications,
  GROUP_CAP,
  type CollectInput,
  type DocRowInput,
  type ShipmentInput,
} from './collectNotifications'

const NOW = Date.parse('2026-11-03T12:00:00Z')

const ship = (over: Partial<ShipmentInput> = {}): ShipmentInput => ({
  id: 's1', number: 'S-1', status: 'IN_TRANSIT', docsMissing: [], legDocsMissing: null, creditHold: null,
  cargoInsuranceExpiresAt: null, liabilityInsuranceExpiresAt: null, carrierName: null, ...over,
})

const docRow = (over: Partial<DocRowInput> = {}): DocRowInput => ({
  key: 'cd:1', kind: 'cd', entityType: 'DRIVER', entityName: 'Dan', title: 'CDL', expiry: '2026-11-10', daysLeft: 7,
  state: 'EXPIRING_SOON', ...over,
})

const base = (over: Partial<CollectInput> = {}): CollectInput => ({
  access: { admin: true, hasPage: () => false },
  nowMs: NOW,
  checkCalls: [], shipments: [], docRows: [], reviewDocuments: [], workflowRuns: [],
  ...over,
})

const find = (groups: ReturnType<typeof collectNotifications>, kind: string) => groups.find((g) => g.kind === kind)

describe('collectNotifications', () => {
  it('grades OVERDUE critical and DUE warn, ignoring other states, critical first', () => {
    const groups = collectNotifications(base({
      checkCalls: [
        { shipmentId: 'a', label: 'A', state: 'DUE', nextCheckCallAt: '2026-11-03T08:00:00Z', carrierName: null },
        { shipmentId: 'b', label: 'B', state: 'OVERDUE', nextCheckCallAt: '2026-11-03T11:00:00Z', carrierName: null },
        { shipmentId: 'c', label: 'C', state: 'SCHEDULED', nextCheckCallAt: null, carrierName: null },
      ],
    }))
    const g = find(groups, 'CHECK_CALLS')!
    expect(g.total).toBe(2)
    expect(g.items.map((i) => [i.id, i.severity])).toEqual([['cc:b', 'critical'], ['cc:a', 'warn']])
    expect(g.items[0].to).toBe('/tms/shipments/b?tab=tracking')
  })

  it('flags a POD only for delivered, unvoided shipments with POD on the gate', () => {
    const groups = collectNotifications(base({
      shipments: [
        ship({ id: 'ok', status: 'DELIVERED', docsMissing: ['POD'] }),
        ship({ id: 'leg', status: 'DELIVERED', legDocsMissing: ['POD'] }),
        ship({ id: 'voided', status: 'DELIVERED', docsMissing: ['POD'], voidedAt: '2026-11-01' }),
        ship({ id: 'moving', status: 'IN_TRANSIT', docsMissing: ['POD'] }),
        ship({ id: 'done', status: 'DELIVERED', docsMissing: [] }),
      ],
    }))
    expect(find(groups, 'PODS')!.items.map((i) => i.id).sort()).toEqual(['pod:leg', 'pod:ok'])
  })

  it('credit hold: one item per customer with its open-shipment count, none when all are delivered or voided', () => {
    const groups = collectNotifications(base({
      shipments: [
        ship({ id: '1', customerName: 'ACME', creditHold: true }),
        ship({ id: '2', customerName: 'ACME', creditHold: true, status: 'BOOKED' }),
        ship({ id: '3', customerName: 'ACME', creditHold: true, status: 'DELIVERED' }),
        ship({ id: '4', customerName: 'Done Co', creditHold: true, status: 'DELIVERED' }),
        ship({ id: '5', customerName: 'Void Co', creditHold: true, voidedAt: '2026-11-01' }),
      ],
    }))
    const g = find(groups, 'CREDIT')!
    expect(g.items).toHaveLength(1)
    expect(g.items[0].title).toContain('ACME')
    expect(g.items[0].detail).toBe('2 open shipments')
    expect(g.items[0].to).toBe('/tms/shipments?q=ACME')
  })

  it('documents group holds exactly the overview rows that are expiring or expired, and review counts pending ones', () => {
    const groups = collectNotifications(base({
      docRows: [
        docRow({ key: 'cd:soon' }),
        docRow({ key: 'cd:gone', state: 'EXPIRED', daysLeft: -2 }),
        docRow({ key: 'cd:ok', state: 'VALID' }),
        docRow({ key: 'cd:pending', state: 'PENDING_REVIEW' }),
      ],
    }))
    const g = find(groups, 'DOCUMENTS')!
    expect(g.items.map((i) => i.id)).toEqual(['doc:cd:gone', 'doc:cd:soon'])
    expect(find(groups, 'REVIEW')!.items[0].to).toBe('/compliance?tab=review')
  })

  it('carrier insurance counts only for open shipments within the warning window', () => {
    const groups = collectNotifications(base({
      shipments: [
        ship({ id: 'a', carrierName: 'Fast', cargoInsuranceExpiresAt: '2026-11-01' }),
        ship({ id: 'b', carrierName: 'Fast', cargoInsuranceExpiresAt: '2027-03-01' }),
        ship({ id: 'c', carrierName: 'Fast', status: 'DELIVERED', cargoInsuranceExpiresAt: '2026-11-01' }),
      ],
    }))
    const g = find(groups, 'DOCUMENTS')!
    expect(g.items.map((i) => [i.id, i.severity])).toEqual([['ins:a:Cargo insurance', 'critical']])
  })

  it('drops every group the user cannot open', () => {
    const input = base({
      access: { admin: false, hasPage: (k) => k === 'files' },
      checkCalls: [{ shipmentId: 'a', label: 'A', state: 'OVERDUE', nextCheckCallAt: null, carrierName: null }],
      shipments: [ship({ id: 'p', status: 'DELIVERED', docsMissing: ['POD'], customerName: 'X', creditHold: true })],
      docRows: [docRow()],
      reviewDocuments: [{ id: 'r', shipmentId: 's' , name: 'n' }],
      workflowRuns: [{ id: 'w', agent: 'AP' }],
    })
    expect(collectNotifications(input).map((g) => g.kind)).toEqual(['DOCUMENTS'])
    expect(collectNotifications({ ...input, access: { admin: false, hasPage: () => false } })).toEqual([])
  })

  it('caps items per group while total counts all, and sorts critical, warn, then oldest first', () => {
    const checkCalls = Array.from({ length: GROUP_CAP + 5 }, (_, i) => ({
      shipmentId: `s${i}`, label: `L${i}`,
      state: i === 12 ? ('OVERDUE' as const) : ('DUE' as const),
      nextCheckCallAt: `2026-11-03T${String(10 - Math.floor(i / 2)).padStart(2, '0')}:00:00Z`,
      carrierName: null,
    }))
    const g = find(collectNotifications(base({ checkCalls })), 'CHECK_CALLS')!
    expect(g.total).toBe(GROUP_CAP + 5)
    expect(g.items).toHaveLength(GROUP_CAP)
    expect(g.items[0].id).toBe('cc:s12')
    const warn = g.items.slice(1)
    expect(warn.map((i) => i.at)).toEqual([...warn.map((i) => i.at)].sort())
  })
})
