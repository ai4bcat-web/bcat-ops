import { beforeEach, describe, expect, it, vi } from 'vitest'

const { graphql } = vi.hoisted(() => ({ graphql: vi.fn() }))
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql }) }))
import { listMaintenanceInvoices } from './apiClient'

beforeEach(() => { graphql.mockReset() })

describe('maintenance invoice loading', () => {
  it('includes invoices beyond an empty intermediate page and ignores null records', async () => {
    const first = { id: 'first', equipmentId: 'truck-1' }
    const last = { id: 'last', equipmentId: 'truck-2' }
    const pages = new Map([
      [null, { items: [first, null], nextToken: 'middle' }],
      ['middle', { items: [], nextToken: 'last' }],
      ['last', { items: [last], nextToken: null }],
    ])
    graphql.mockImplementation(async ({ variables }) => {
      const page = pages.get(variables?.nextToken ?? null)
      if (!page) throw new Error('Invalid pagination token')
      return { data: { listMaintenanceInvoices: page } }
    })
    expect(await listMaintenanceInvoices()).toEqual([first, last])
  })

  it('rejects rather than displaying a partial list when a later page fails', async () => {
    graphql.mockResolvedValueOnce({ data: { listMaintenanceInvoices: {
      items: [{ id: 'first', equipmentId: 'truck-1' }], nextToken: 'next',
    } } }).mockRejectedValueOnce(new Error('Access denied'))
    await expect(listMaintenanceInvoices()).rejects.toThrow('Access denied')
  })
})
