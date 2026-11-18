import { describe, expect, it, vi } from 'vitest'

const graphql = vi.hoisted(() => vi.fn())
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql }) }))

import { listApPaymentsInWindow } from './paymentsClient'

describe('listApPaymentsInWindow', () => {
  it('leaves out payments made outside BCAT Ops (archived, Ryne 2026-11-18): that cash was not moved by this system', async () => {
    graphql.mockResolvedValueOnce({
      data: {
        listApPayments: {
          items: [
            { id: 'live', carrierId: 'c1', kind: 'PAYMENT', paidAt: '2026-11-18T12:00:00.000Z', amountCents: 95000, archivedAt: null },
            { id: 'old', carrierId: 'c2', kind: 'PAYMENT', paidAt: '2026-11-10T12:00:00.000Z', amountCents: 12000, archivedAt: '2026-11-18T23:00:00.000Z' },
          ],
          nextToken: null,
        },
      },
    })
    const rows = await listApPaymentsInWindow('2026-11-01', '2026-11-30')
    expect(rows.map((r) => r.id)).toEqual(['live'])
    expect(String((graphql.mock.calls[0][0] as { query: string }).query)).toContain('archivedAt')
  })
})
