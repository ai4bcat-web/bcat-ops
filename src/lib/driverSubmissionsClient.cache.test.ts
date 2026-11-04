import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGraphql } = vi.hoisted(() => ({ mockGraphql: vi.fn() }))
vi.mock('aws-amplify/data', () => ({ generateClient: vi.fn(() => ({ graphql: mockGraphql })) }))
vi.mock('aws-amplify/storage', () => ({ uploadData: vi.fn(), getUrl: vi.fn() }))
vi.mock('./podsClient', () => ({ queueDriverDocScan: vi.fn() }))

import { invalidateLists } from './listCache'
import { listDriverSubmissions, setDriverSubmissionLoad } from './driverSubmissionsClient'

let served = 0
const names = () => mockGraphql.mock.calls.map(([o]) => /(?:query|mutation) (\w+)/.exec((o as { query: string }).query)?.[1])

beforeEach(() => {
  invalidateLists()
  served = 0
  mockGraphql.mockReset()
  mockGraphql.mockImplementation(async ({ query }: { query: string }) => {
    if (/^\s*mutation/.test(query)) return { data: { updateDriverSubmission: { id: 's1' } } }
    if (query.includes('ListDriverSubmissionDocs')) return { data: { listDriverSubmissionDocs: { items: [{ id: 'd1', submissionId: 's1' }], nextToken: null } } }
    served += 1
    return { data: { listDriverSubmissions: { items: [{ id: 's1' }], nextToken: null } } }
  })
})

describe('driverSubmissionsClient shared reads', () => {
  it('six simultaneous mounts cost one submissions request and one documents request', async () => {
    const all = await Promise.all(Array.from({ length: 6 }, () => listDriverSubmissions()))
    expect(names().filter((n) => n === 'ListDriverSubmissions')).toHaveLength(1)
    expect(names().filter((n) => n === 'ListDriverSubmissionDocs')).toHaveLength(1)
    expect(all.every((rows) => rows[0].docs.length === 1)).toBe(true)
    expect(all[0]).not.toBe(all[1]) // each caller owns its array
  })

  it('a write through the client drops the window, and fresh bypasses it', async () => {
    await listDriverSubmissions()
    await listDriverSubmissions()
    expect(served).toBe(1)
    await setDriverSubmissionLoad('s1', 'L1')
    await listDriverSubmissions()
    expect(served).toBe(2)
    await listDriverSubmissions(1000, { fresh: true })
    expect(served).toBe(3)
  })
})
