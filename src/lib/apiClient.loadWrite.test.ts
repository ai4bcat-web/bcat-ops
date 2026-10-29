/**
 * What a signed-in client is allowed to put in a Load write.
 *
 * `voidedAt`, `aljexId`, `tmsId` and `pickupNumber` are field-level read-only on the Load
 * model: voiding owns the first, and a PRO is claimed atomically and never released, so
 * SET_LOAD_PRO owns the other three. AppSync refuses the WHOLE mutation with
 * "Unauthorized on [aljexId]" when any of them is present, and the drawer and the calendar
 * both save a payload that still carries them — so a stray field here is not a field that
 * fails to write, it is every unrelated load save failing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graphqlMock = vi.fn()
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: graphqlMock }) }))
vi.mock('aws-amplify/storage', () => ({ uploadData: vi.fn(), getUrl: vi.fn(), remove: vi.fn() }))

const { updateLoad } = await import('./apiClient')

/** The input object the mutation actually went out with. */
function sentInput(): Record<string, unknown> {
  const call = graphqlMock.mock.calls[0]?.[0]
  if (!call || typeof call !== 'object' || !('variables' in call)) throw new Error('no mutation was sent')
  const { variables } = call as { variables: { input: Record<string, unknown> } }
  return variables.input
}

beforeEach(() => {
  graphqlMock.mockReset()
  graphqlMock.mockResolvedValue({ data: { updateLoad: { id: 'l1', stops: null } } })
})

describe('updateLoad', () => {
  it('strips the identity fields the client may not write', async () => {
    await updateLoad('l1', {
      aljexId: '14580',
      tmsId: 'PO-9',
      pickupNumber: 'PU-1',
      voidedAt: '2026-10-01T00:00:00.000Z',
      notes: 'moved the delivery',
    } as never)

    const input = sentInput()
    expect(input).not.toHaveProperty('aljexId')
    expect(input).not.toHaveProperty('tmsId')
    expect(input).not.toHaveProperty('pickupNumber')
    expect(input).not.toHaveProperty('voidedAt')
  })

  it('still writes the fields the client does own', async () => {
    await updateLoad('l1', { aljexId: '14580', notes: 'moved the delivery', miles: 412 } as never)

    expect(sentInput()).toMatchObject({ id: 'l1', notes: 'moved the delivery', miles: 412 })
  })
})
