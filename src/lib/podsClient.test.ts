import { beforeEach, describe, expect, it, vi } from 'vitest'

const graphql = vi.hoisted(() => vi.fn())
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql }) }))
vi.mock('@/lib/apiClient', () => ({ graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)) }))

import { configurePods, listPods } from './podsClient'
import { invalidateLists } from './listCache'

beforeEach(() => {
  graphql.mockReset()
  invalidateLists()
})

describe('listPods when the POD connection is not configured', () => {
  it('asks the backend once, however many hooks read the pods, until a pod write', async () => {
    graphql.mockRejectedValue(new Error('POD connection is not configured'))
    await expect(listPods()).rejects.toThrow('not configured')
    await expect(listPods()).rejects.toThrow('not configured')
    await expect(listPods()).rejects.toThrow('not configured')
    expect(graphql).toHaveBeenCalledTimes(1)

    graphql.mockResolvedValue({ data: { managePods: JSON.stringify({ configured: true }) } })
    await configurePods({ apiKey: 'k', clientId: 'c' })
    graphql.mockResolvedValue({ data: { managePods: JSON.stringify({ items: [], nextToken: null }) } })
    await expect(listPods()).resolves.toEqual({ items: [], nextToken: null })
  })
})
