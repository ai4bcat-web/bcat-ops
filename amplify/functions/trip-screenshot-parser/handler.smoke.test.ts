import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { finalMessage, stream, ctor } = vi.hoisted(() => {
  delete process.env.ANTHROPIC_API_KEY
  const finalMessage = vi.fn()
  const stream = vi.fn(() => ({ finalMessage }))
  const ctor = vi.fn()
  return { finalMessage, stream, ctor }
})

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { stream }
    constructor(opts: unknown) { ctor(opts) }
  }
  return { default: Anthropic }
})

import { handler } from './handler'

let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  finalMessage.mockReset()
  delete process.env.ANTHROPIC_API_KEY
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  error.mockRestore()
  delete process.env.ANTHROPIC_API_KEY
})

describe('trip-screenshot-parser handler', () => {
  it('reports a missing API key without calling the model', async () => {
    const res = await handler({ arguments: { imageBase64: 'abc' } })
    expect(res).toEqual({ trips: null, error: 'ANTHROPIC_API_KEY secret is not set in the Amplify console yet' })
    expect(ctor).not.toHaveBeenCalled()
  })

  it('rejects an empty image with no-image', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    const res = await handler({ arguments: { imageBase64: '' } })
    expect(res).toEqual({ trips: null, error: 'no-image' })
    expect(stream).not.toHaveBeenCalled()
  })

  it('returns the parsed trips from the model response', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    const trip = { loadId: 'T-1', origin: 'A', destination: 'B', miles: 10, equipment: 'Tractor', freightAmount: 100, ratePerMile: 10, status: 'Completed', date: '2026-01-01' }
    finalMessage.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ trips: [trip] }) }] })
    const res = await handler({ arguments: { imageBase64: 'abc', todayISO: '2026-01-05' } })
    expect(res).toEqual({ trips: [trip], error: null })
  })

  it('reports a refusal', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    finalMessage.mockResolvedValue({ stop_reason: 'refusal', content: [] })
    const res = await handler({ arguments: { imageBase64: 'abc' } })
    expect(res).toEqual({ trips: null, error: 'The model declined to read this image — try a tighter crop of just the trips table' })
  })

  it('turns a timeout into the actionable message and passes other errors through', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    finalMessage.mockRejectedValueOnce(new Error('Request timed out: timeout'))
    const timedOut = await handler({ arguments: { imageBase64: 'abc' } })
    expect(timedOut.trips).toBeNull()
    expect(timedOut.error).toMatch(/took too long/)

    finalMessage.mockRejectedValueOnce(new Error('boom'))
    expect(await handler({ arguments: { imageBase64: 'abc' } })).toEqual({ trips: null, error: 'boom' })
  })
})
