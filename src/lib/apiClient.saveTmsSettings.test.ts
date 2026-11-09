/**
 * Saving TmsSettings when the row was created after the page loaded ("expectedUpdatedAt is
 * required"): refetch the row and retry once with its token, but never overwrite what someone
 * else wrote to a field this save is about.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graphqlMock = vi.fn()
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: graphqlMock }) }))
vi.mock('aws-amplify/storage', () => ({ uploadData: vi.fn(), getUrl: vi.fn(), remove: vi.fn() }))

const { saveTmsSettings } = await import('./apiClient')

const REQUIRED = { errors: [{ message: 'expectedUpdatedAt is required' }] }

/** Scripted backend: `row` is what a refetch returns; `saves` answers each SAVE_SETTINGS in turn. */
function backend(row: Record<string, unknown> | null, saves: Array<unknown>) {
  const queue = [...saves]
  graphqlMock.mockImplementation(async (call: { query: string; variables?: { action?: string; input?: string } }) => {
    if (call.query.includes('GetTmsSettings')) return { data: { getTmsSettings: row } }
    const next = queue.shift()
    if (next && typeof next === 'object' && 'errors' in next) throw next
    return { data: { tmsDirectoryActions: JSON.stringify(next) } }
  })
}

const saveCalls = () =>
  graphqlMock.mock.calls
    .map(([c]) => c as { query: string; variables?: { input: string } })
    .filter((c) => c.variables?.input)
    .map((c) => JSON.parse(c.variables!.input) as Record<string, unknown>)
const refetches = () => graphqlMock.mock.calls.filter(([c]) => (c as { query: string }).query.includes('GetTmsSettings')).length

beforeEach(() => { graphqlMock.mockReset() })

describe('saveTmsSettings', () => {
  it('saves straight through when the page held a token: no refetch', async () => {
    backend(null, [{ id: 'default', updatedAt: 'T2' }])
    await saveTmsSettings({ marginFloorBps: 500 }, 'T1')
    expect(saveCalls()).toEqual([{ id: 'default', expectedUpdatedAt: 'T1', marginFloorBps: 500 }])
    expect(refetches()).toBe(0)
  })

  it('first save where the row did not exist at load but exists now: refetches and retries once with its token', async () => {
    // Another writer (e.g. the appointments page) created the row with only its own field.
    backend({ id: 'default', updatedAt: 'T9', autoClearPastAppts: true, marginFloorBps: null }, [REQUIRED, { id: 'default', updatedAt: 'T10' }])
    const saved = await saveTmsSettings({ marginFloorBps: 500, defaultPaymentTermsDays: 30 })
    expect(saved.updatedAt).toBe('T10')
    const calls = saveCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0].expectedUpdatedAt).toBeUndefined()
    expect(calls[1]).toEqual({ id: 'default', expectedUpdatedAt: 'T9', marginFloorBps: 500, defaultPaymentTermsDays: 30 })
    expect(refetches()).toBe(1)
  })

  it('does not overwrite a field the new row already holds with a different value: conflict, no second save', async () => {
    backend({ id: 'default', updatedAt: 'T9', marginFloorBps: 900 }, [REQUIRED, { id: 'default', updatedAt: 'T10' }])
    await expect(saveTmsSettings({ marginFloorBps: 500 })).rejects.toThrow(/changed by someone else/)
    expect(saveCalls()).toHaveLength(1)
  })

  it('compares structured fields by value, not identity', async () => {
    const codes = [{ code: 'DET', label: 'Detention' }]
    backend({ id: 'default', updatedAt: 'T9', accessorialCodes: [{ label: 'Detention', code: 'DET' }] }, [REQUIRED, { id: 'default', updatedAt: 'T10' }])
    await expect(saveTmsSettings({ accessorialCodes: codes as never })).resolves.toMatchObject({ updatedAt: 'T10' })
    expect(saveCalls()).toHaveLength(2)
  })

  it('retries at most once: a second refusal surfaces, no loop', async () => {
    backend({ id: 'default', updatedAt: 'T9' }, [REQUIRED, REQUIRED, REQUIRED])
    await expect(saveTmsSettings({ marginFloorBps: 500 })).rejects.toThrow(/expectedUpdatedAt is required/)
    expect(saveCalls()).toHaveLength(2)
    expect(refetches()).toBe(1)
  })

  it('surfaces the original error when the row cannot be found on refetch', async () => {
    backend(null, [REQUIRED])
    await expect(saveTmsSettings({ marginFloorBps: 500 })).rejects.toThrow(/expectedUpdatedAt is required/)
    expect(saveCalls()).toHaveLength(1)
  })

  it('never retries any other error, nor a stale-token conflict', async () => {
    backend({ id: 'default', updatedAt: 'T9' }, [{ errors: [{ message: 'This settings was changed by someone else — reload and try again.' }] }])
    await expect(saveTmsSettings({ marginFloorBps: 500 }, 'T1')).rejects.toThrow(/changed by someone else/)
    backend({ id: 'default', updatedAt: 'T9' }, [{ errors: [{ message: 'marginFloorBps must be an integer' }] }])
    await expect(saveTmsSettings({ marginFloorBps: 500 })).rejects.toThrow(/must be an integer/)
    expect(refetches()).toBe(0)
  })
})
